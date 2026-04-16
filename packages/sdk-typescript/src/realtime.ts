import type { WsMessage, Message } from '@agentchat/shared'
import type { AgentChatClient } from './client.js'
import { ConnectionError } from './errors.js'

export type MessageHandler = (message: WsMessage) => void
export type ErrorHandler = (error: Error) => void

export interface SequenceGapInfo {
  conversationId: string
  // The seq we were waiting for when the gap window expired.
  expectedSeq: number
  // The lowest seq we had buffered above the expected — what triggered
  // the gap detection. Null when the gap was discovered some other way
  // (e.g. buffer overflow without a clear "next" arrival).
  bufferedSeq: number | null
  // Wall-clock duration we waited before resolving the gap, in ms.
  gapMs: number
  // True iff getMessages successfully returned the missing rows and we
  // dispatched them in order before any higher seqs. False means we
  // gave up and emitted whatever we had (possibly skipping some seqs
  // forever — caller should /sync to fully reconcile).
  recovered: boolean
  reason:
    | 'gap_filled'
    | 'gap_fill_failed'
    | 'gap_fill_unavailable'
    | 'buffer_overflow'
}

export type SequenceGapHandler = (info: SequenceGapInfo) => void

export interface RealtimeOptions {
  apiKey: string
  baseUrl?: string
  reconnect?: boolean
  reconnectInterval?: number
  maxReconnectAttempts?: number
  /**
   * Optional client used for in-order recovery. When the realtime feed
   * sees a per-conversation seq gap (e.g. msg.seq=8 then msg.seq=12),
   * we wait briefly for the missing rows to arrive naturally, then call
   * client.getMessages(conversationId, { afterSeq: lastSeenSeq }) to
   * pull them and emit in order. If omitted, gaps still resolve but
   * the missing seqs are skipped — the buffered higher-seq messages
   * are emitted after the timeout, and `onSequenceGap` reports the
   * incident with `recovered: false`.
   */
  client?: AgentChatClient
  /**
   * Fired whenever a per-conversation seq gap is detected and resolved
   * (one way or the other). Use this to emit metrics, log incidents,
   * or trigger an explicit /sync if `recovered: false`.
   */
  onSequenceGap?: SequenceGapHandler
}

// Time to wait for `hello.ok` after sending the HELLO frame before we give
// up and reconnect. Must stay under the server-side HELLO_TIMEOUT_MS (5s).
const HELLO_ACK_TIMEOUT_MS = 4_000

// How long we wait for the missing seqs to arrive naturally (e.g. via the
// pub/sub fan-out catching up to the drain) before triggering an explicit
// gap-fill round-trip. Two seconds is well below the perceptual floor for
// agent loops (which tick in hundreds of ms minimum) and well above the
// typical drain↔live-fanout interleave window (10–100 ms). The cost when
// no real gap exists is zero — the timer is started lazily on detection
// and cancelled the moment the missing seq arrives.
const GAP_FILL_WINDOW_MS = 2_000

// Hard cap on how many out-of-order messages we hold per conversation
// before draining unconditionally. Prevents memory blow-up if a sender
// publishes wildly off-sequence or a server bug emits seqs in the wrong
// order at high volume. 500 is well above realistic burst sizes (group
// fan-out batches at 100), so we only hit this in true pathologies — at
// which point we surface it via onSequenceGap and continue.
const MAX_BUFFERED_PER_CONVERSATION = 500

// Cap on how many messages we'll request from the server in one gap-fill
// round-trip. If the gap is bigger than this, recovery is best-effort and
// the application should call /sync afterwards to fully reconcile. The
// onSequenceGap callback fires with recovered:false if we couldn't close
// the gap completely.
const GAP_FILL_LIMIT = 200

interface OrderState {
  // The next seq we expect to dispatch. Null means we're un-anchored —
  // the next `message.new` with a numeric seq sets this to seq + 1.
  // Re-set to null on disconnect so the post-reconnect /sync drain can
  // re-anchor without false gap detections across the connection break.
  nextExpectedSeq: number | null
  // Out-of-order messages waiting on a missing earlier seq. Keyed by
  // seq for O(1) lookup during the consecutive-drain pass.
  buffer: Map<number, WsMessage>
  gapTimer: ReturnType<typeof setTimeout> | null
  gapStartedAt: number | null
  // The seq we were waiting on when the gap timer started. Used so a
  // later arrival of an even-higher seq doesn't reset the timer or
  // confuse the gap report.
  gapStartedExpectedSeq: number | null
  // True while a getMessages call is in flight, so a re-detect of the
  // same gap doesn't kick off a parallel fetch.
  gapFillInFlight: boolean
}

export class RealtimeClient {
  private ws: WebSocket | null = null
  private options: {
    apiKey: string
    baseUrl: string
    reconnect: boolean
    reconnectInterval: number
    maxReconnectAttempts: number
    client?: AgentChatClient
    onSequenceGap?: SequenceGapHandler
  }
  private handlers = new Map<string, Set<MessageHandler>>()
  private errorHandlers = new Set<ErrorHandler>()
  private reconnectAttempts = 0
  private helloAckTimer: ReturnType<typeof setTimeout> | null = null
  private authenticated = false
  private orderStates = new Map<string, OrderState>()

  constructor(options: RealtimeOptions) {
    this.options = {
      baseUrl: options.baseUrl ?? 'wss://api.agentchat.me',
      reconnect: options.reconnect ?? true,
      reconnectInterval: options.reconnectInterval ?? 3000,
      maxReconnectAttempts: options.maxReconnectAttempts ?? 10,
      apiKey: options.apiKey,
      client: options.client,
      onSequenceGap: options.onSequenceGap,
    }
  }

  connect(): void {
    // Authenticate via HELLO frame (not URL). Browser WebSocket cannot set
    // custom headers, so this is the only cross-runtime path. The API key
    // never appears in the URL, access logs, or Referer headers.
    const url = `${this.options.baseUrl}/v1/ws`
    this.ws = new WebSocket(url)
    this.authenticated = false

    this.ws.onopen = () => {
      try {
        this.ws!.send(JSON.stringify({ type: 'hello', api_key: this.options.apiKey }))
      } catch (err) {
        this.emitError(err instanceof Error ? err : new ConnectionError('HELLO send failed'))
        return
      }

      this.helloAckTimer = setTimeout(() => {
        this.emitError(new ConnectionError('HELLO ack timeout'))
        try { this.ws?.close(1008, 'HELLO ack timeout') } catch { /* already closed */ }
      }, HELLO_ACK_TIMEOUT_MS)
    }

    this.ws.onmessage = (event) => {
      let message: WsMessage
      try {
        message = JSON.parse(String(event.data)) as WsMessage
      } catch {
        return
      }

      // Intercept the handshake ACK — never surfaces to user handlers.
      if (!this.authenticated) {
        if ((message as { type?: string }).type === 'hello.ok') {
          this.authenticated = true
          this.reconnectAttempts = 0
          if (this.helloAckTimer) {
            clearTimeout(this.helloAckTimer)
            this.helloAckTimer = null
          }
        }
        return
      }

      // Per-conversation seq ordering applies only to message.new — every
      // other event type (presence, group.deleted, message.read, system
      // messages without a seq) passes straight through.
      if (this.isMessageNew(message)) {
        this.processOrderedMessage(message)
        return
      }
      this.dispatch(message)
    }

    this.ws.onerror = () => {
      this.emitError(new ConnectionError('WebSocket error'))
    }

    this.ws.onclose = () => {
      if (this.helloAckTimer) {
        clearTimeout(this.helloAckTimer)
        this.helloAckTimer = null
      }
      this.authenticated = false

      // Drop all per-conversation ordering state. Across the connection
      // break the application is responsible for calling /sync, which
      // re-establishes the cursor via the next message.new arrival.
      // Leaving stale nextExpectedSeq values would cause spurious gap
      // detections after reconnect when a /sync drain delivers
      // higher-seq rows than what live previously emitted.
      this.resetOrderStates()

      if (this.options.reconnect && this.reconnectAttempts < this.options.maxReconnectAttempts) {
        this.reconnectAttempts++
        setTimeout(() => this.connect(), this.options.reconnectInterval)
      }
    }
  }

  on(event: string, handler: MessageHandler): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set())
    }
    this.handlers.get(event)!.add(handler)
  }

  onError(handler: ErrorHandler): void {
    this.errorHandlers.add(handler)
  }

  send(message: WsMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.authenticated) {
      throw new ConnectionError('WebSocket is not connected')
    }
    this.ws.send(JSON.stringify(message))
  }

  disconnect(): void {
    this.options.reconnect = false
    if (this.helloAckTimer) {
      clearTimeout(this.helloAckTimer)
      this.helloAckTimer = null
    }
    // Flush any buffered envelopes synchronously so the caller doesn't
    // miss them after disconnect(). No gap-fill — we're tearing down,
    // and an in-flight HTTP request would race the close.
    this.drainAllPendingForShutdown()
    this.ws?.close()
    this.ws = null
    this.authenticated = false
  }

  private emitError(error: Error): void {
    for (const handler of this.errorHandlers) {
      handler(error)
    }
  }

  private dispatch(message: WsMessage): void {
    const handlers = this.handlers.get(message.type)
    if (!handlers) return
    for (const handler of handlers) {
      handler(message)
    }
  }

  private isMessageNew(message: WsMessage): boolean {
    return (message as { type?: string }).type === 'message.new'
  }

  // ─── Per-conversation seq ordering ───────────────────────────────────────
  //
  // Invariant: for any conversation_id, handlers see message.new envelopes
  // strictly in seq-ascending order with no skipped or repeated seqs (modulo
  // the gap-fill failure path, where we surface the incident via
  // onSequenceGap and continue forward).
  //
  // Why per-conversation instead of global: seq numbers are minted per
  // conversation by send_message_atomic, so cross-conversation arrivals
  // have no ordering relationship to enforce.

  private processOrderedMessage(message: WsMessage): void {
    const payload = (message as { payload?: { conversation_id?: unknown; seq?: unknown } }).payload
    const conversationId = payload?.conversation_id

    // No conversation_id → not a real fan-out envelope. Pass through so a
    // malformed or extension envelope isn't silently dropped.
    if (typeof conversationId !== 'string') {
      this.dispatch(message)
      return
    }

    const seq = this.extractSeq(message)
    // System messages (e.g. server-emitted notices reusing message.new
    // shape) may not carry a numeric seq. Dispatch immediately rather
    // than blocking the per-conversation cursor on a non-orderable msg.
    if (seq === null) {
      this.dispatch(message)
      return
    }

    const state = this.getOrCreateOrderState(conversationId)

    // First arrival for this conversation in this connection — anchor.
    // We can't validate against history we never saw; the application
    // is responsible for running /sync if it cares about earlier rows.
    if (state.nextExpectedSeq === null) {
      state.nextExpectedSeq = seq + 1
      this.dispatch(message)
      return
    }

    if (seq < state.nextExpectedSeq) {
      // Duplicate — usually a drain↔live-fanout race after reconnect, or
      // a server-side double-publish. We've already dispatched this seq
      // (or skipped it during a gap-fill failure), so drop silently.
      return
    }

    if (seq === state.nextExpectedSeq) {
      // The expected next message — dispatch and try to drain any
      // higher-seq messages that were waiting on this one.
      this.dispatch(message)
      state.nextExpectedSeq = seq + 1
      this.drainConsecutive(conversationId, state)
      // The drain may have closed the gap that motivated a pending timer.
      this.maybeClearGapTimer(state)
      this.cleanupIfIdle(conversationId, state)
      return
    }

    // seq > nextExpectedSeq — out of order. Buffer and start the gap timer
    // if not already running.
    state.buffer.set(seq, message)

    if (state.buffer.size > MAX_BUFFERED_PER_CONVERSATION) {
      // Pathological: emit everything we have and skip past the gap.
      this.resolveGap(conversationId, state, {
        recovered: false,
        reason: 'buffer_overflow',
        bufferedSeq: this.minBufferedSeq(state),
      })
      return
    }

    if (state.gapTimer === null) {
      state.gapStartedAt = Date.now()
      state.gapStartedExpectedSeq = state.nextExpectedSeq
      state.gapTimer = setTimeout(() => {
        void this.handleGapTimer(conversationId)
      }, GAP_FILL_WINDOW_MS)
    }
  }

  private async handleGapTimer(conversationId: string): Promise<void> {
    const state = this.orderStates.get(conversationId)
    if (!state) return
    state.gapTimer = null

    // Race: the missing seq might have arrived while the timer was
    // queued (the dispatch-loop drain didn't trigger maybeClearGapTimer
    // because the timer was still ticking). If we're caught up, exit.
    if (state.buffer.size === 0) {
      this.cleanupIfIdle(conversationId, state)
      return
    }

    const expectedSeq = state.nextExpectedSeq
    if (expectedSeq === null) return // shouldn't happen, defensive

    // No client → can't gap-fill. Drain in seq order, advance past the
    // gap, surface the incident.
    if (!this.options.client) {
      this.resolveGap(conversationId, state, {
        recovered: false,
        reason: 'gap_fill_unavailable',
        bufferedSeq: this.minBufferedSeq(state),
      })
      return
    }

    // Already fetching (e.g. the timer fired again before the previous
    // call returned). Defer; the in-flight call will resolve everything.
    if (state.gapFillInFlight) return
    state.gapFillInFlight = true

    let fetched: Message[] = []
    let fillError = false
    try {
      // afterSeq is exclusive (seq > N), so subtract 1 to make the
      // expected seq inclusive. The server caps internally at GAP_FILL_LIMIT
      // worth of rows; we pass our own limit as a belt-and-braces.
      fetched = await this.options.client.getMessages(conversationId, {
        afterSeq: expectedSeq - 1,
        limit: GAP_FILL_LIMIT,
      })
    } catch {
      fillError = true
    } finally {
      state.gapFillInFlight = false
    }

    // The state may have been reset (disconnect during the await) — bail.
    const stateNow = this.orderStates.get(conversationId)
    if (!stateNow || stateNow !== state) return

    if (fillError) {
      this.resolveGap(conversationId, state, {
        recovered: false,
        reason: 'gap_fill_failed',
        bufferedSeq: this.minBufferedSeq(state),
      })
      return
    }

    // Insert fetched rows into the buffer (skip anything below our cursor —
    // shouldn't happen but defensive against server-side filtering changes).
    for (const row of fetched) {
      const rowSeq = typeof row.seq === 'number' ? row.seq : null
      if (rowSeq === null || rowSeq < expectedSeq) continue
      // Skip if already in buffer (the natural arrival beat us to it).
      if (state.buffer.has(rowSeq)) continue
      // Wrap as a message.new envelope for the dispatch path.
      state.buffer.set(rowSeq, {
        type: 'message.new',
        payload: row as unknown as Record<string, unknown>,
      })
    }

    // Drain consecutive starting from expectedSeq. If we still hit a gap
    // after draining (the server returned [9, 10, 12] when we needed 11),
    // that's a partial recovery — surface as recovered:false but keep
    // moving. The application should /sync to fully reconcile.
    const drainedThroughGap = this.drainConsecutive(conversationId, state)
    if (drainedThroughGap) {
      this.resolveGap(conversationId, state, {
        recovered: true,
        reason: 'gap_filled',
        bufferedSeq: null,
      })
    } else {
      // Either the fetch returned nothing useful or there's still a hole.
      // Drop into the same fallback path as gap_fill_failed: dispatch
      // whatever's contiguous-from-buffer-min and skip ahead.
      this.resolveGap(conversationId, state, {
        recovered: false,
        reason: 'gap_fill_failed',
        bufferedSeq: this.minBufferedSeq(state),
      })
    }
  }

  // Returns true if we drained at least one message past the original
  // expected seq (i.e. the gap is closed for now). Returns false if the
  // expected seq still isn't in the buffer — caller decides what to do.
  private drainConsecutive(conversationId: string, state: OrderState): boolean {
    if (state.nextExpectedSeq === null) return false
    let drained = false
    while (state.buffer.has(state.nextExpectedSeq)) {
      const msg = state.buffer.get(state.nextExpectedSeq)!
      state.buffer.delete(state.nextExpectedSeq)
      this.dispatch(msg)
      state.nextExpectedSeq += 1
      drained = true
    }
    if (drained) this.cleanupIfIdle(conversationId, state)
    return drained
  }

  // Force-resolve a gap by dispatching every buffered message in seq
  // order, advancing nextExpectedSeq past the highest, and firing the
  // onSequenceGap callback. Used for unrecoverable cases (no client,
  // fetch failed, buffer overflow).
  private resolveGap(
    conversationId: string,
    state: OrderState,
    info: {
      recovered: boolean
      reason: SequenceGapInfo['reason']
      bufferedSeq: number | null
    },
  ): void {
    const expectedSeq = state.gapStartedExpectedSeq ?? state.nextExpectedSeq ?? 0
    const gapMs = state.gapStartedAt !== null ? Date.now() - state.gapStartedAt : 0

    const seqs = Array.from(state.buffer.keys()).sort((a, b) => a - b)
    let highestDispatched = state.nextExpectedSeq !== null ? state.nextExpectedSeq - 1 : -1
    for (const s of seqs) {
      const msg = state.buffer.get(s)!
      this.dispatch(msg)
      if (s > highestDispatched) highestDispatched = s
    }
    state.buffer.clear()
    if (highestDispatched >= 0) {
      state.nextExpectedSeq = highestDispatched + 1
    }

    if (state.gapTimer !== null) {
      clearTimeout(state.gapTimer)
      state.gapTimer = null
    }
    state.gapStartedAt = null
    state.gapStartedExpectedSeq = null

    this.options.onSequenceGap?.({
      conversationId,
      expectedSeq,
      bufferedSeq: info.bufferedSeq,
      gapMs,
      recovered: info.recovered,
      reason: info.reason,
    })

    this.cleanupIfIdle(conversationId, state)
  }

  private maybeClearGapTimer(state: OrderState): void {
    if (state.gapTimer !== null && state.buffer.size === 0) {
      clearTimeout(state.gapTimer)
      state.gapTimer = null
      state.gapStartedAt = null
      state.gapStartedExpectedSeq = null
    }
  }

  private getOrCreateOrderState(conversationId: string): OrderState {
    let state = this.orderStates.get(conversationId)
    if (!state) {
      state = {
        nextExpectedSeq: null,
        buffer: new Map(),
        gapTimer: null,
        gapStartedAt: null,
        gapStartedExpectedSeq: null,
        gapFillInFlight: false,
      }
      this.orderStates.set(conversationId, state)
    }
    return state
  }

  // Drop the per-conversation entry once it's quiescent (no buffered
  // messages, no pending gap timer, no in-flight fetch). Keeps the map
  // bounded — without this, every conversation an agent ever touches
  // would leave a stale entry alive for the lifetime of the connection.
  private cleanupIfIdle(conversationId: string, state: OrderState): void {
    if (
      state.buffer.size === 0 &&
      state.gapTimer === null &&
      !state.gapFillInFlight
    ) {
      this.orderStates.delete(conversationId)
    }
  }

  private extractSeq(message: WsMessage): number | null {
    const seq = (message as { payload?: { seq?: unknown } }).payload?.seq
    return typeof seq === 'number' && Number.isFinite(seq) ? seq : null
  }

  private minBufferedSeq(state: OrderState): number | null {
    if (state.buffer.size === 0) return null
    let min = Infinity
    for (const k of state.buffer.keys()) if (k < min) min = k
    return Number.isFinite(min) ? min : null
  }

  private resetOrderStates(): void {
    for (const state of this.orderStates.values()) {
      if (state.gapTimer !== null) clearTimeout(state.gapTimer)
    }
    this.orderStates.clear()
  }

  private drainAllPendingForShutdown(): void {
    for (const [conversationId, state] of this.orderStates) {
      if (state.gapTimer !== null) {
        clearTimeout(state.gapTimer)
        state.gapTimer = null
      }
      if (state.buffer.size === 0) continue
      const seqs = Array.from(state.buffer.keys()).sort((a, b) => a - b)
      for (const s of seqs) this.dispatch(state.buffer.get(s)!)
      state.buffer.clear()
      this.options.onSequenceGap?.({
        conversationId,
        expectedSeq: state.gapStartedExpectedSeq ?? state.nextExpectedSeq ?? 0,
        bufferedSeq: seqs[0] ?? null,
        gapMs: state.gapStartedAt !== null ? Date.now() - state.gapStartedAt : 0,
        recovered: false,
        reason: 'gap_fill_unavailable',
      })
    }
    this.orderStates.clear()
  }
}
