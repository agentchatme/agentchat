import type { WsMessage, Message } from './types/index.js'
import type { AgentChatClient } from './client.js'
import { ConnectionError } from './errors.js'
import { resolveWebSocket } from './ws-resolver.js'

export type MessageHandler = (message: WsMessage) => void
export type ErrorHandler = (error: Error) => void

/**
 * Fired once per successful HELLO_ACK. Useful for updating UI ("connected"
 * state), (re)subscribing to typing indicators, emitting metrics, etc.
 * Not guaranteed to be called on the initial connect — only after a
 * handshake completes.
 */
export type ConnectHandler = () => void

/** Fired on every socket close, regardless of reason. */
export type DisconnectHandler = (info: { code: number; reason: string; wasClean: boolean }) => void

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
  /** Auto-reconnect on unexpected close. Default: `true`. */
  reconnect?: boolean
  /**
   * Initial reconnect delay in milliseconds. Subsequent reconnects use
   * exponential backoff with ±25% jitter, capped at
   * `maxReconnectInterval`. Default: 500ms.
   */
  reconnectInterval?: number
  /** Maximum delay between reconnect attempts. Default: 30s. */
  maxReconnectInterval?: number
  /** Maximum total reconnect attempts before giving up. Default: Infinity. */
  maxReconnectAttempts?: number
  /**
   * Optional client used for in-order recovery AND for the post-reconnect
   * `/v1/messages/sync` drain.
   *
   * - **Gap recovery**: when the realtime feed sees a per-conversation seq
   *   gap (e.g. `seq=8` then `seq=12`), the client waits briefly for
   *   natural arrival, then calls `getMessages(conversationId, { afterSeq })`
   *   to pull the missing rows and emit them in order.
   * - **Reconnect drain**: after every successful `hello.ok`, the client
   *   calls `/v1/messages/sync` to pull envelopes that accumulated while
   *   disconnected, dispatches them through the same `message.new`
   *   pipeline, and acknowledges with `/v1/messages/sync/ack`.
   *
   * Without a `client`, neither recovery path is available — gaps fire
   * `onSequenceGap` with `recovered: false`, and offline envelopes sit
   * in the server-side queue until the application calls `sync()`
   * manually.
   */
  client?: AgentChatClient
  /**
   * Fired whenever a per-conversation seq gap is detected and resolved
   * (one way or the other). Use this to emit metrics, log incidents,
   * or trigger an explicit `/sync` if `recovered: false`.
   */
  onSequenceGap?: SequenceGapHandler
  /**
   * Disable the automatic post-reconnect `/v1/messages/sync` drain. On by
   * default when a `client` is provided. Turn off if you prefer to run
   * sync on your own schedule.
   */
  autoDrainOnConnect?: boolean
  /**
   * Override the WebSocket constructor. Defaults to `globalThis.WebSocket`
   * with a dynamic-import fallback to the `ws` package (for Node 20).
   * Tests use this to inject a mock. Users on a polyfilled environment
   * can supply their own implementation — anything that matches the
   * browser WebSocket shape (`onopen/onmessage/onclose/onerror`, `send`,
   * `close`, `readyState`) works.
   */
  webSocket?: typeof globalThis.WebSocket
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
    maxReconnectInterval: number
    maxReconnectAttempts: number
    client?: AgentChatClient
    onSequenceGap?: SequenceGapHandler
    autoDrainOnConnect: boolean
    webSocket?: typeof globalThis.WebSocket
  }
  private handlers = new Map<string, Set<MessageHandler>>()
  private errorHandlers = new Set<ErrorHandler>()
  private connectHandlers = new Set<ConnectHandler>()
  private disconnectHandlers = new Set<DisconnectHandler>()
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private helloAckTimer: ReturnType<typeof setTimeout> | null = null
  private authenticated = false
  private orderStates = new Map<string, OrderState>()
  private disposed = false

  constructor(options: RealtimeOptions) {
    this.options = {
      baseUrl: options.baseUrl ?? 'wss://api.agentchat.me',
      reconnect: options.reconnect ?? true,
      reconnectInterval: options.reconnectInterval ?? 500,
      maxReconnectInterval: options.maxReconnectInterval ?? 30_000,
      maxReconnectAttempts: options.maxReconnectAttempts ?? Number.POSITIVE_INFINITY,
      apiKey: options.apiKey,
      client: options.client,
      onSequenceGap: options.onSequenceGap,
      autoDrainOnConnect: options.autoDrainOnConnect ?? Boolean(options.client),
      webSocket: options.webSocket,
    }
  }

  /**
   * Open the WebSocket connection and perform the HELLO handshake.
   * Resolves once the socket is open and the HELLO frame has been sent —
   * NOT after `hello.ok`. Listen for `onConnect()` to react to a
   * completed handshake.
   *
   * Safe to call on a disposed client only if you expect a fresh run —
   * reinstate with a new instance instead.
   */
  async connect(): Promise<void> {
    if (this.disposed) {
      throw new ConnectionError('RealtimeClient has been disposed; create a new instance to reconnect.')
    }

    let WebSocketCtor: typeof globalThis.WebSocket
    try {
      WebSocketCtor = this.options.webSocket ?? (await resolveWebSocket())
    } catch (err) {
      const error = err instanceof Error ? err : new ConnectionError('Failed to resolve WebSocket')
      this.emitError(error)
      this.scheduleReconnect()
      throw error
    }

    // Authenticate via HELLO frame (not URL). Browser WebSocket cannot set
    // custom headers, so this is the only cross-runtime path. The API key
    // never appears in the URL, access logs, or Referer headers.
    const url = `${this.options.baseUrl}/v1/ws`
    this.ws = new WebSocketCtor(url)
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

    this.ws.onmessage = (event: MessageEvent) => {
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
          for (const handler of this.connectHandlers) {
            try { handler() } catch { /* user hook must not break flow */ }
          }
          if (this.options.autoDrainOnConnect && this.options.client) {
            void this.drainOfflineEnvelopes()
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

    this.ws.onclose = (event: CloseEvent) => {
      if (this.helloAckTimer) {
        clearTimeout(this.helloAckTimer)
        this.helloAckTimer = null
      }
      this.authenticated = false

      for (const handler of this.disconnectHandlers) {
        try {
          handler({ code: event.code, reason: event.reason, wasClean: event.wasClean })
        } catch { /* user hook must not break flow */ }
      }

      // Drop all per-conversation ordering state. Across the connection
      // break the application is responsible for calling /sync (or
      // enabling `autoDrainOnConnect`), which re-establishes the cursor
      // via the next message.new arrival. Leaving stale nextExpectedSeq
      // values would cause spurious gap detections after reconnect when
      // a /sync drain delivers higher-seq rows than what live previously
      // emitted.
      this.resetOrderStates()

      this.scheduleReconnect()
    }
  }

  /**
   * Drain offline envelopes accumulated while the socket was disconnected.
   * Fires `message.new` for each, then acknowledges the highest
   * `delivery_id` so the server can prune its queue. Automatically
   * invoked on every successful `hello.ok` when `autoDrainOnConnect` is
   * enabled and a client is configured.
   *
   * Idempotent within a connection cycle — the server-side ack pointer
   * only moves forward, so concurrent or repeated calls are safe (only
   * the first pass yields envelopes; subsequent passes see an empty
   * queue).
   */
  async drainOfflineEnvelopes(): Promise<void> {
    const client = this.options.client
    if (!client) return

    // Loop until the server reports an empty queue. In practice one page
    // suffices (the queue is per-agent and the default limit is high),
    // but very long offline windows may span multiple batches.
    while (true) {
      let batch: { envelopes: Array<{ delivery_id: number; message: Message }> }
      try {
        batch = await client.sync()
      } catch (err) {
        this.emitError(err instanceof Error ? err : new ConnectionError('sync drain failed'))
        return
      }
      if (batch.envelopes.length === 0) return

      let highestDeliveryId = -1
      for (const env of batch.envelopes) {
        if (env.delivery_id > highestDeliveryId) highestDeliveryId = env.delivery_id
        // Route through the same pipeline as live envelopes — per-convo
        // seq ordering, gap detection, dispatch to `message.new` handlers.
        const wrapped: WsMessage = {
          type: 'message.new',
          payload: env.message as unknown as Record<string, unknown>,
        }
        this.processOrderedMessage(wrapped)
      }

      if (highestDeliveryId >= 0) {
        try {
          await client.syncAck(highestDeliveryId)
        } catch (err) {
          this.emitError(err instanceof Error ? err : new ConnectionError('sync ack failed'))
          return
        }
      }

      // If the server returned fewer than a page, we're caught up.
      if (batch.envelopes.length < 100) return
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed) return
    if (!this.options.reconnect) return
    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) return
    if (this.reconnectTimer) return

    this.reconnectAttempts++
    const delay = this.computeReconnectDelay(this.reconnectAttempts)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect().catch((err) => {
        this.emitError(err instanceof Error ? err : new ConnectionError(String(err)))
      })
    }, delay)
  }

  private computeReconnectDelay(attempt: number): number {
    const exp = this.options.reconnectInterval * Math.pow(2, Math.min(attempt - 1, 10))
    const capped = Math.min(exp, this.options.maxReconnectInterval)
    // ±25% jitter avoids thundering-herd reconnect when a whole fleet
    // drops at the same moment.
    const jitter = 0.75 + Math.random() * 0.5
    return Math.max(0, Math.floor(capped * jitter))
  }

  on(event: string, handler: MessageHandler): () => void {
    let handlers = this.handlers.get(event)
    if (!handlers) {
      handlers = new Set()
      this.handlers.set(event, handlers)
    }
    handlers.add(handler)
    return () => {
      handlers!.delete(handler)
      if (handlers!.size === 0) this.handlers.delete(event)
    }
  }

  onError(handler: ErrorHandler): () => void {
    this.errorHandlers.add(handler)
    return () => this.errorHandlers.delete(handler)
  }

  /** Fires each time the handshake completes (initial + every reconnect). */
  onConnect(handler: ConnectHandler): () => void {
    this.connectHandlers.add(handler)
    return () => this.connectHandlers.delete(handler)
  }

  /** Fires on every socket close, regardless of reason (clean or error). */
  onDisconnect(handler: DisconnectHandler): () => void {
    this.disconnectHandlers.add(handler)
    return () => this.disconnectHandlers.delete(handler)
  }

  send(message: WsMessage): void {
    // `WebSocket.OPEN` is 1 per the spec — hardcode rather than reading
    // from `WebSocket.OPEN`, which is only available as a static on
    // whichever constructor we resolved (native vs `ws`).
    if (!this.ws || this.ws.readyState !== 1 || !this.authenticated) {
      throw new ConnectionError('WebSocket is not connected')
    }
    this.ws.send(JSON.stringify(message))
  }

  /** `true` after a completed HELLO handshake and before the next close. */
  get isConnected(): boolean {
    return this.authenticated && this.ws?.readyState === 1
  }

  /**
   * Close the socket, disable auto-reconnect, and release all handlers.
   * After calling this, `connect()` throws — create a fresh
   * `RealtimeClient` if you want to reopen.
   */
  disconnect(): void {
    this.disposed = true
    this.options.reconnect = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.helloAckTimer) {
      clearTimeout(this.helloAckTimer)
      this.helloAckTimer = null
    }
    // Flush any buffered envelopes synchronously so the caller doesn't
    // miss them after disconnect(). No gap-fill — we're tearing down,
    // and an in-flight HTTP request would race the close.
    this.drainAllPendingForShutdown()
    try { this.ws?.close() } catch { /* already closed */ }
    this.ws = null
    this.authenticated = false
    this.handlers.clear()
    this.errorHandlers.clear()
    this.connectHandlers.clear()
    this.disconnectHandlers.clear()
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
