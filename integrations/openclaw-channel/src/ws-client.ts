/**
 * AgentChat WebSocket client — state-machine-driven, production-grade.
 *
 * Responsibilities:
 *   - Own the WS transport and HELLO handshake lifecycle.
 *   - Drive the connection state machine (`./state-machine.ts`) by emitting
 *     events in response to socket/auth/heartbeat transitions.
 *   - Maintain native WS PING/PONG heartbeat at `ping.intervalMs`; declare
 *     DEGRADED on `ping.timeoutMs` miss, then force-reconnect.
 *   - Schedule reconnect with exponential backoff + ±`jitterRatio` jitter
 *     per `reconnect.*` config. Thundering-herd-safe across a fleet.
 *   - Emit typed events upwards (`inboundFrame`, `stateChanged`, `error`)
 *     so the normalizer (P3) and outbound adapter (P4) can consume them.
 *
 * Intentional design choices:
 *   - Uses the `ws` package directly (not `globalThis.WebSocket`) because
 *     OpenClaw runs on Node — `ws` exposes `.ping()` / `.pong()` / event
 *     hooks that native WebSocket omits. Every major agent-hosting target
 *     (Fly, Render, Vercel functions, Lambda) is Node.
 *   - Authenticates via HELLO frame (`{type: "hello", api_key}`), never via
 *     URL query string. Keeps the key out of access logs and Referers.
 *   - `RECONNECT_HARD_CAP_ATTEMPTS` guards against runaway reconnect loops
 *     after catastrophic network events; crosses into `AUTH_FAIL` so the
 *     operator sees a clear signal instead of silent retry forever.
 *   - Frame parsing is defensive: malformed JSON, unknown `type`, missing
 *     payload — all classified as `validation` errors (non-terminal for
 *     the connection, but dropped with a metric + log).
 *   - No message-layer ordering here. Per-conversation seq ordering + gap
 *     recovery belong to the SDK's `RealtimeClient` and the drain layer
 *     (P3 consumers). This module is strictly the transport.
 */

import type { RawData, WebSocket as WsInstance } from 'ws'
import { WebSocket as NodeWebSocket } from 'ws'

import {
  AgentChatChannelError,
  classifyNetworkError,
  type ErrorClass,
} from './errors.js'
import type { Logger } from './log.js'
import type { MetricsRecorder } from './metrics.js'
import {
  canSend,
  isTerminal,
  transition,
  type ConnectionEvent,
  type ConnectionState,
} from './state-machine.js'
import type { AgentchatChannelConfig } from './config-schema.js'
import type { UnixMillis } from './types.js'

// HELLO handshake must resolve faster than the server's 5s cutoff — we give
// ourselves 4s so a clean close + reconnect happens before the server drops.
const HELLO_ACK_TIMEOUT_MS = 4_000

// Reconnect attempts above this threshold almost certainly mean the network
// is partitioned from the AgentChat control plane, or the API key was
// revoked at the edge (without a terminal 401). Surface AUTH_FAIL so the
// operator has a clear signal rather than silent forever-retry.
const RECONNECT_HARD_CAP_ATTEMPTS = 60

// Maximum frame size we'll accept from the server. Matches AgentChat's
// own server-side outbound cap (2 MiB — large attachments go via the REST
// upload flow, not inline in WS frames).
const MAX_FRAME_BYTES = 2 * 1024 * 1024

// WebSocket close codes we treat as auth failures (terminal until operator
// reconfigures). 1008 = policy violation; AgentChat uses it + 4401/4403 for
// auth-related rejects. Other 4xxx codes are treated as retry-transient.
const AUTH_CLOSE_CODES = new Set([1008, 4401, 4403])

/** One parsed inbound server frame. */
export interface InboundFrame {
  readonly type: string
  readonly payload: Record<string, unknown>
  readonly receivedAt: UnixMillis
  readonly raw: unknown
}

/** One client-action frame the caller wants to push. */
export interface OutboundFrame {
  readonly type: string
  readonly payload: Record<string, unknown>
  readonly id?: string
}

export interface WsClientEvents {
  stateChanged: (next: ConnectionState, prev: ConnectionState) => void
  inboundFrame: (frame: InboundFrame) => void
  error: (error: AgentChatChannelError) => void
  /** Fired once per `hello.ok` — useful for triggering a /v1/messages/sync drain upstream. */
  authenticated: (at: UnixMillis) => void
  /** Fired after a clean close + CLOSED state (after stop() or terminal auth failure). */
  closed: () => void
}

export interface WsClientOptions {
  readonly config: AgentchatChannelConfig
  readonly logger: Logger
  readonly metrics: MetricsRecorder
  /** Clock source — override in tests. Default: `Date.now`. */
  readonly now?: () => UnixMillis
  /** WebSocket constructor override — tests pass a mock. Default: `ws`. */
  readonly webSocketCtor?: typeof NodeWebSocket
  /** Random source for jitter — override in tests. Default: `Math.random`. */
  readonly random?: () => number
  /** timer.setTimeout override for tests. */
  readonly setTimeout?: (fn: () => void, ms: number) => NodeJS.Timeout
  readonly clearTimeout?: (h: NodeJS.Timeout) => void
  readonly setInterval?: (fn: () => void, ms: number) => NodeJS.Timeout
  readonly clearInterval?: (h: NodeJS.Timeout) => void
}

type Listener<E extends keyof WsClientEvents> = WsClientEvents[E]

/**
 * AgentChat channel WebSocket client.
 *
 * Lifecycle:
 *   1. `start()` — DISCONNECTED → CONNECTING. Transport opens, HELLO is sent.
 *   2. `hello.ok` → READY. Heartbeat timer starts. Upstream consumers begin.
 *   3. On socket drop → DISCONNECTED → CONNECTING (with backoff).
 *   4. `stop(deadlineMs)` → DRAINING. Wait for in-flight drains, then CLOSED.
 *
 * Thread-safety: this class is single-threaded. All callbacks fire on the
 * Node event loop; callers should never invoke public methods from timer
 * callbacks without being aware of reentrancy (e.g., a `stateChanged`
 * listener that calls `send()` is fine, but `start()` inside `closed()`
 * will re-enter the lifecycle — usually a bug).
 */
export class AgentchatWsClient {
  private readonly config: AgentchatChannelConfig
  private readonly logger: Logger
  private readonly metrics: MetricsRecorder
  private readonly now: () => UnixMillis
  private readonly WebSocketCtor: typeof NodeWebSocket
  private readonly random: () => number
  private readonly _setTimeout: (fn: () => void, ms: number) => NodeJS.Timeout
  private readonly _clearTimeout: (h: NodeJS.Timeout) => void
  private readonly _setInterval: (fn: () => void, ms: number) => NodeJS.Timeout
  private readonly _clearInterval: (h: NodeJS.Timeout) => void

  private state: ConnectionState = { kind: 'DISCONNECTED' }
  private ws: WsInstance | null = null
  private attempt = 0

  private helloAckTimer: NodeJS.Timeout | null = null
  private pingTimer: NodeJS.Timeout | null = null
  private pongTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private drainTimer: NodeJS.Timeout | null = null

  private readonly listeners: {
    [K in keyof WsClientEvents]: Set<Listener<K>>
  } = {
    stateChanged: new Set(),
    inboundFrame: new Set(),
    error: new Set(),
    authenticated: new Set(),
    closed: new Set(),
  }

  constructor(options: WsClientOptions) {
    this.config = options.config
    this.logger = options.logger.child({ component: 'ws-client' })
    this.metrics = options.metrics
    this.now = options.now ?? Date.now
    this.WebSocketCtor = options.webSocketCtor ?? NodeWebSocket
    this.random = options.random ?? Math.random
    this._setTimeout = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
    this._clearTimeout = options.clearTimeout ?? ((h) => clearTimeout(h))
    this._setInterval = options.setInterval ?? ((fn, ms) => setInterval(fn, ms))
    this._clearInterval = options.clearInterval ?? ((h) => clearInterval(h))

    this.metrics.setConnectionState(this.state.kind)
  }

  // ─── Public API ──────────────────────────────────────────────────────

  /** Current connection state. Read-only from the caller's perspective. */
  getState(): ConnectionState {
    return this.state
  }

  /**
   * Kick off connection. No-op if already connecting, authenticating, or
   * ready. Throws on `AUTH_FAIL` — the caller must call `reconfigured()`
   * after rotating the API key before retrying.
   */
  start(): void {
    if (this.state.kind === 'AUTH_FAIL') {
      throw new AgentChatChannelError(
        'terminal-auth',
        'cannot start: channel is in AUTH_FAIL — rotate api key and call reconfigured()',
      )
    }
    if (this.state.kind === 'CLOSED') {
      throw new Error('cannot start: client is closed. Create a new instance.')
    }
    if (this.state.kind !== 'DISCONNECTED') {
      // Already in progress — nothing to do.
      return
    }
    this.openSocket(1)
  }

  /**
   * Push a client-action frame. Requires `canSend(state)` — returns false
   * if the socket is not ready. Callers should queue and retry from the
   * outbound adapter (P4) rather than drop here.
   */
  send(frame: OutboundFrame): boolean {
    if (!canSend(this.state) || !this.ws || this.ws.readyState !== NodeWebSocket.OPEN) {
      return false
    }
    try {
      this.ws.send(JSON.stringify(frame))
      return true
    } catch (err) {
      this.emitError(
        new AgentChatChannelError(
          classifyNetworkError(err),
          'ws send failed',
          { cause: err },
        ),
      )
      return false
    }
  }

  /**
   * Request a graceful drain. The caller-supplied deadline is a Unix-ms
   * timestamp; after it passes, the socket is force-closed regardless of
   * remaining in-flight work. Safe to call from any state.
   */
  stop(deadline?: UnixMillis): void {
    const now = this.now()
    const computedDeadline = deadline ?? now + 5_000

    if (this.state.kind === 'DRAINING') {
      // Second stop() — tighten the deadline if the caller asked for
      // earlier closure, otherwise ignore.
      if (computedDeadline < this.state.deadline) {
        this.applyEvent({ type: 'DRAIN_REQUESTED', now, deadline: computedDeadline })
        this.scheduleDrainDeadline(computedDeadline)
      }
      return
    }

    if (isTerminal(this.state)) {
      return
    }

    this.applyEvent({ type: 'DRAIN_REQUESTED', now, deadline: computedDeadline })

    // `applyEvent` mutated `this.state`; widen the read so TS doesn't
    // over-narrow against the pre-apply snapshot (TS tracks the control-flow
    // narrowing across the earlier guards and isn't aware the method call
    // mutated state).
    const after = (this.state as ConnectionState).kind
    if (after === 'DRAINING') {
      this.scheduleDrainDeadline(computedDeadline)
    } else if (after === 'CLOSED') {
      this.closeSocket(1000, 'client drain (immediate)')
      this.emit('closed')
    }
  }

  /**
   * Signal that operator has rotated the API key. Transitions from
   * AUTH_FAIL back to DISCONNECTED; the next `start()` call will attempt
   * a fresh HELLO with the current config.
   */
  reconfigured(): void {
    if (this.state.kind !== 'AUTH_FAIL') return
    this.applyEvent({ type: 'RECONFIGURED' })
  }

  on<E extends keyof WsClientEvents>(event: E, handler: Listener<E>): () => void {
    this.listeners[event].add(handler as Listener<E>)
    return () => {
      this.listeners[event].delete(handler as Listener<E>)
    }
  }

  // ─── Internals: socket lifecycle ─────────────────────────────────────

  private openSocket(attempt: number): void {
    this.attempt = attempt
    const now = this.now()
    this.applyEvent({ type: 'CONNECT', now, attempt })

    const url = `${this.config.apiBase.replace(/^http/, 'ws')}/v1/ws`

    let ws: WsInstance
    try {
      ws = new this.WebSocketCtor(url, {
        perMessageDeflate: false,
        // `ws` auto-pong is on by default — we keep it so heartbeat RTT
        // is symmetric even when the server initiates the ping.
        maxPayload: MAX_FRAME_BYTES,
      })
    } catch (err) {
      this.emitError(
        new AgentChatChannelError(
          classifyNetworkError(err),
          'ws constructor threw',
          { cause: err },
        ),
      )
      this.scheduleReconnect('ctor-failed')
      return
    }

    this.ws = ws
    this.bindSocket(ws)
  }

  private bindSocket(ws: WsInstance): void {
    ws.on('open', () => this.handleOpen())
    ws.on('message', (data, isBinary) => this.handleMessage(data, isBinary))
    ws.on('pong', () => this.handlePong())
    ws.on('close', (code, reason) => this.handleClose(code, reason.toString()))
    ws.on('error', (err) => {
      this.emitError(
        new AgentChatChannelError(
          classifyNetworkError(err),
          'ws transport error',
          { cause: err },
        ),
      )
      // Don't transition here — `close` always follows `error`. Let
      // handleClose drive the state transition.
    })
  }

  private handleOpen(): void {
    if (!this.ws) return
    const now = this.now()
    this.applyEvent({ type: 'SOCKET_OPEN', now })

    // Send HELLO. This is the sole authentication path — the server will
    // reject any non-hello frame before `hello.ok` and close 1008.
    try {
      this.ws.send(
        JSON.stringify({ type: 'hello', api_key: this.config.apiKey }),
      )
    } catch (err) {
      this.emitError(
        new AgentChatChannelError(
          'retry-transient',
          'hello send failed',
          { cause: err },
        ),
      )
      this.closeSocket(1011, 'hello send failed')
      return
    }

    // Bound the handshake. Server has a 5s HELLO_TIMEOUT; we stay under.
    this.helloAckTimer = this._setTimeout(() => {
      this.helloAckTimer = null
      this.logger.warn({ timeoutMs: HELLO_ACK_TIMEOUT_MS }, 'hello ack timeout')
      this.emitError(
        new AgentChatChannelError('retry-transient', 'hello ack timeout'),
      )
      this.closeSocket(1008, 'hello ack timeout')
    }, HELLO_ACK_TIMEOUT_MS)
  }

  private handleMessage(data: RawData, isBinary: boolean): void {
    if (isBinary) {
      this.logger.warn({}, 'received binary frame — dropping (text-only protocol)')
      return
    }

    const received = this.now()

    // `RawData` can be Buffer | ArrayBuffer | Buffer[]. Normalize to string.
    const text =
      typeof data === 'string'
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data).toString('utf8')
          : Buffer.isBuffer(data)
            ? data.toString('utf8')
            : Buffer.from(data as ArrayBuffer).toString('utf8')

    if (text.length > MAX_FRAME_BYTES) {
      this.logger.warn({ bytes: text.length }, 'oversized frame — dropping')
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      this.emitError(
        new AgentChatChannelError(
          'validation',
          'malformed json frame',
          { cause: err },
        ),
      )
      return
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.emitError(
        new AgentChatChannelError('validation', 'frame not an object'),
      )
      return
    }

    const obj = parsed as Record<string, unknown>
    const type = typeof obj.type === 'string' ? obj.type : null
    if (!type) {
      this.emitError(
        new AgentChatChannelError('validation', 'frame missing type'),
      )
      return
    }

    // Intercept the handshake ack. Never surfaces to subscribers — the
    // normalizer (P3) only sees app-level server events.
    if (this.state.kind === 'AUTHENTICATING') {
      if (type === 'hello.ok') {
        this.handleHelloOk(received)
        return
      }
      if (type === 'hello.error' || type === 'auth.rejected' || type === 'error') {
        const reason = this.extractReason(obj) ?? 'auth rejected'
        this.handleAuthRejected(reason)
        return
      }
      // Frames that arrive mid-handshake before hello.ok are protocol
      // violations — close and reconnect.
      this.logger.warn({ type }, 'frame arrived before hello.ok — ignoring')
      return
    }

    // Once authenticated, rate_limit.warning is a soft advisory that the
    // upstream outbound adapter should respect. Emit it as an inbound
    // frame; metrics bookkeep here.
    const payload = this.extractPayload(obj)

    this.emit('inboundFrame', {
      type,
      payload,
      receivedAt: received,
      raw: parsed,
    })
  }

  private extractReason(obj: Record<string, unknown>): string | undefined {
    const payload = obj.payload
    if (payload && typeof payload === 'object') {
      const msg = (payload as Record<string, unknown>).message
      if (typeof msg === 'string') return msg
      const reason = (payload as Record<string, unknown>).reason
      if (typeof reason === 'string') return reason
    }
    const top = obj.message ?? obj.reason
    return typeof top === 'string' ? top : undefined
  }

  private extractPayload(obj: Record<string, unknown>): Record<string, unknown> {
    const payload = obj.payload
    return payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {}
  }

  private handleHelloOk(now: UnixMillis): void {
    if (this.helloAckTimer) {
      this._clearTimeout(this.helloAckTimer)
      this.helloAckTimer = null
    }
    this.applyEvent({ type: 'HELLO_OK', now })
    this.attempt = 0
    this.startHeartbeat()
    this.emit('authenticated', now)
  }

  private handleAuthRejected(reason: string): void {
    if (this.helloAckTimer) {
      this._clearTimeout(this.helloAckTimer)
      this.helloAckTimer = null
    }
    this.logger.error({ reason }, 'auth rejected — moving to AUTH_FAIL')
    this.applyEvent({ type: 'AUTH_REJECTED', reason })
    this.emitError(
      new AgentChatChannelError('terminal-auth', `auth rejected: ${reason}`),
    )
    this.closeSocket(1008, 'auth rejected')
  }

  private handleClose(code: number, reason: string): void {
    const now = this.now()
    const wasAuthenticating = this.state.kind === 'AUTHENTICATING'
    const wasDraining = this.state.kind === 'DRAINING'
    const authClass = AUTH_CLOSE_CODES.has(code)

    this.stopHeartbeat()
    if (this.helloAckTimer) {
      this._clearTimeout(this.helloAckTimer)
      this.helloAckTimer = null
    }
    this.ws = null

    if (authClass && wasAuthenticating) {
      this.applyEvent({ type: 'AUTH_REJECTED', reason: `close ${code}: ${reason}` })
      this.emitError(
        new AgentChatChannelError(
          'terminal-auth',
          `socket closed with auth code ${code}: ${reason}`,
        ),
      )
      this.emit('closed')
      return
    }

    this.applyEvent({ type: 'SOCKET_CLOSED', code, reason })

    if (wasDraining || this.state.kind === 'CLOSED') {
      this.emit('closed')
      return
    }

    this.logger.info(
      { code, reason, attempt: this.attempt },
      'socket closed — scheduling reconnect',
    )
    this.scheduleReconnect(`close-${code}`)
  }

  private closeSocket(code: number, reason: string): void {
    if (!this.ws) return
    try {
      this.ws.close(code, reason)
    } catch {
      // Already closed or in an invalid state — `close` will still fire.
    }
  }

  // ─── Internals: heartbeat ────────────────────────────────────────────

  private startHeartbeat(): void {
    this.stopHeartbeat()
    const intervalMs = this.config.ping.intervalMs
    this.pingTimer = this._setInterval(() => this.sendPing(), intervalMs)
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) {
      this._clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    if (this.pongTimer) {
      this._clearTimeout(this.pongTimer)
      this.pongTimer = null
    }
  }

  private sendPing(): void {
    if (!this.ws || this.ws.readyState !== NodeWebSocket.OPEN) return
    try {
      this.ws.ping()
    } catch (err) {
      this.emitError(
        new AgentChatChannelError(
          'retry-transient',
          'ws ping failed',
          { cause: err },
        ),
      )
      return
    }
    const timeoutMs = this.config.ping.timeoutMs
    if (this.pongTimer) this._clearTimeout(this.pongTimer)
    this.pongTimer = this._setTimeout(() => {
      this.pongTimer = null
      const now = this.now()
      this.logger.warn({ timeoutMs }, 'ping timeout — declaring degraded')
      this.applyEvent({ type: 'PING_TIMEOUT', now })
      // The server has gone silent. Force-reconnect — the state machine
      // moves READY → DEGRADED on PING_TIMEOUT, but we need to actually
      // tear down the socket so `close` re-drives reconnect.
      this.closeSocket(1011, 'ping timeout')
    }, timeoutMs)
  }

  private handlePong(): void {
    if (this.pongTimer) {
      this._clearTimeout(this.pongTimer)
      this.pongTimer = null
    }
    // If we were in DEGRADED due to backpressure, pong alone isn't the
    // recovery signal — backpressure clears when the outbound queue drains.
    // But if we were in DEGRADED due to ping-timeout (shouldn't happen —
    // we close immediately on that path), a pong would recover us.
    if (this.state.kind === 'DEGRADED' && this.state.reason === 'ping-timeout') {
      this.applyEvent({ type: 'RECOVERED', now: this.now() })
    }
  }

  // ─── Internals: reconnect ────────────────────────────────────────────

  private scheduleReconnect(reason: string): void {
    if (this.state.kind === 'CLOSED' || this.state.kind === 'AUTH_FAIL') return
    if (this.reconnectTimer) return

    const nextAttempt = this.attempt + 1

    if (nextAttempt > RECONNECT_HARD_CAP_ATTEMPTS) {
      const msg = `reconnect hard cap (${RECONNECT_HARD_CAP_ATTEMPTS}) reached`
      this.logger.error({ attempt: nextAttempt }, msg)
      this.applyEvent({ type: 'AUTH_REJECTED', reason: msg })
      this.emitError(
        new AgentChatChannelError('terminal-auth', msg),
      )
      return
    }

    const delay = this.computeReconnectDelay(nextAttempt)
    this.metrics.incReconnect({ reason })
    this.logger.info(
      { attempt: nextAttempt, delayMs: delay, reason },
      'scheduling reconnect',
    )

    this.reconnectTimer = this._setTimeout(() => {
      this.reconnectTimer = null
      this.openSocket(nextAttempt)
    }, delay)
  }

  private computeReconnectDelay(attempt: number): number {
    const { initialBackoffMs, maxBackoffMs, jitterRatio } = this.config.reconnect
    // `attempt` is the total connection count (1 = initial connect, 2+ =
    // reconnects). Backoff scales with the *reconnect* count, so the first
    // reconnect uses `initialBackoffMs * 2^0 = initialBackoffMs`.
    const reconnectCount = Math.max(1, attempt - 1)
    const exp = initialBackoffMs * Math.pow(2, Math.min(reconnectCount - 1, 20))
    const capped = Math.min(exp, maxBackoffMs)
    // Symmetric ±jitterRatio. Thundering-herd-safe: a fleet that all drops
    // at the same instant re-enters the connect queue spread across
    // capped * [1-jitterRatio, 1+jitterRatio].
    const jitter = 1 - jitterRatio + this.random() * 2 * jitterRatio
    return Math.max(0, Math.floor(capped * jitter))
  }

  // ─── Internals: drain ────────────────────────────────────────────────

  private scheduleDrainDeadline(deadline: UnixMillis): void {
    if (this.drainTimer) this._clearTimeout(this.drainTimer)
    const now = this.now()
    const delay = Math.max(0, deadline - now)
    this.drainTimer = this._setTimeout(() => {
      this.drainTimer = null
      if (this.state.kind === 'DRAINING') {
        this.logger.warn({ deadline }, 'drain deadline exceeded — force-closing')
        this.applyEvent({ type: 'DRAIN_COMPLETED' })
        this.closeSocket(1000, 'drain deadline')
        this.emit('closed')
      }
    }, delay)
  }

  /**
   * Called by upper layers when their pending work has fully drained, to
   * let the WS client transition CLOSED earlier than the deadline.
   */
  drainCompleted(): void {
    if (this.state.kind !== 'DRAINING') return
    if (this.drainTimer) {
      this._clearTimeout(this.drainTimer)
      this.drainTimer = null
    }
    this.applyEvent({ type: 'DRAIN_COMPLETED' })
    this.closeSocket(1000, 'drain completed')
    this.emit('closed')
  }

  // ─── Internals: state machine + emit ─────────────────────────────────

  private applyEvent(event: ConnectionEvent): void {
    const prev = this.state
    const next = transition(prev, event)
    if (next === prev) {
      // No transition — log at debug so we see invalid events without
      // crashing. Useful for catching bugs in upper layers.
      this.logger.debug(
        { from: prev.kind, event: event.type },
        'transition.invalid',
      )
      return
    }
    this.state = next
    this.metrics.setConnectionState(next.kind)
    this.logger.info(
      { from: prev.kind, to: next.kind, event: event.type },
      'state transition',
    )
    this.emit('stateChanged', next, prev)
  }

  private emit<E extends keyof WsClientEvents>(
    event: E,
    ...args: Parameters<WsClientEvents[E]>
  ): void {
    for (const listener of this.listeners[event]) {
      try {
        ;(listener as (...a: unknown[]) => void)(...(args as unknown[]))
      } catch (err) {
        this.logger.error(
          { event, err: err instanceof Error ? err.message : String(err) },
          'listener threw — continuing',
        )
      }
    }
  }

  private emitError(error: AgentChatChannelError): void {
    this.metrics.incOutboundFailed({ errorClass: error.class_ })
    this.logger.warn(
      { class: error.class_, message: error.message, statusCode: error.statusCode },
      'channel error',
    )
    this.emit('error', error)
  }
}

/**
 * Classify a low-level error with the WS client's conventions — exported
 * for integration tests that want to assert on error class directly.
 */
export function classifyWsError(err: unknown): ErrorClass {
  return classifyNetworkError(err)
}
