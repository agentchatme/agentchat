/**
 * AgentChat channel runtime — single lifecycle object that ties the WS
 * transport (P2), inbound normalizer (P3), and outbound adapter (P4)
 * together. This is the surface an OpenClaw channel binding consumes.
 *
 * Responsibilities:
 *   - Instantiate the WS client, hook its `inboundFrame` event through
 *     `normalizeInbound` and into user-supplied handlers.
 *   - Expose `sendMessage` that delegates to the OutboundAdapter.
 *   - Coordinate drain: `stop(deadline)` waits for outbound in-flight to
 *     clear (up to the deadline) before closing the WS.
 *   - Surface a single `getHealth()` snapshot combining connection state +
 *     outbound queue depth + circuit breaker state.
 *
 * Not in scope here:
 *   - Per-conversation seq ordering and gap recovery — the SDK's
 *     `RealtimeClient` owns that. For the channel plugin, we deliver
 *     inbound frames as they arrive; upper layers can call
 *     `GET /v1/messages/sync` for reconciliation if they require strict
 *     ordering across reconnects.
 *   - OpenClaw ChannelInboundMessage translation — that lives in the
 *     bridge module (consumed by the gateway), not here. Keeping this
 *     module decoupled means it can be smoke-tested without OpenClaw.
 */

import type { Logger } from './log.js'
import type { MetricsRecorder } from './metrics.js'
import { createLogger, type LogLevel } from './log.js'
import { createNoopMetrics } from './metrics.js'
import type { AgentchatChannelConfig } from './config-schema.js'
import { AgentchatWsClient, type InboundFrame } from './ws-client.js'
import { normalizeInbound, type NormalizedInbound } from './inbound.js'
import {
  OutboundAdapter,
  type OutboundMessageInput,
  type OutboundBacklogWarning,
  type SendResult,
} from './outbound.js'
import { AgentChatChannelError } from './errors.js'
import type { ConnectionState } from './state-machine.js'
import type { UnixMillis } from './types.js'

export interface ChannelRuntimeHandlers {
  /** Called for every successfully normalized inbound event. */
  onInbound?: (event: NormalizedInbound) => void | Promise<void>
  /** Called whenever a frame fails validation. Default: log-and-drop. */
  onValidationError?: (error: AgentChatChannelError, frame: InboundFrame) => void
  /** Called on state transitions — surface to gateway for health/UI. */
  onStateChanged?: (next: ConnectionState, prev: ConnectionState) => void
  /** Called once per successful HELLO_OK (initial + every reconnect). */
  onAuthenticated?: (at: UnixMillis) => void
  /** Called on every closed/unreachable situation worth observing. */
  onError?: (error: AgentChatChannelError) => void
  /** Called when the server signals a backlog warning on an outbound send. */
  onBacklogWarning?: (warning: OutboundBacklogWarning) => void
}

export interface ChannelRuntimeOptions {
  readonly config: AgentchatChannelConfig
  readonly handlers?: ChannelRuntimeHandlers
  /** Pre-built logger — if absent, we construct one from `config.observability`. */
  readonly logger?: Logger
  /** Pre-built metrics recorder — if absent, uses no-op. */
  readonly metrics?: MetricsRecorder
  readonly fetch?: typeof fetch
  /** Injected for tests. */
  readonly webSocketCtor?: ConstructorParameters<
    typeof AgentchatWsClient
  >[0]['webSocketCtor']
  readonly now?: () => UnixMillis
  readonly random?: () => number
  readonly sleep?: (ms: number) => Promise<void>
}

export interface HealthSnapshot {
  readonly state: ConnectionState
  readonly authenticated: boolean
  readonly outbound: {
    readonly inFlight: number
    readonly queued: number
    readonly circuitState: 'closed' | 'open' | 'half-open'
  }
}

/**
 * Orchestrates the full channel. Construct once per (channelId, accountId)
 * pair at gateway startup; call `start()` to bring it up, `stop()` to
 * drain. Dispose is folded into `stop()` — after it resolves, the
 * instance is terminal.
 */
export class AgentchatChannelRuntime {
  private readonly config: AgentchatChannelConfig
  private readonly handlers: ChannelRuntimeHandlers
  private readonly logger: Logger
  private readonly metrics: MetricsRecorder
  private readonly ws: AgentchatWsClient
  private readonly outbound: OutboundAdapter
  private readonly now: () => UnixMillis
  private started = false
  private authenticated = false
  private stopPromise: Promise<void> | null = null

  constructor(opts: ChannelRuntimeOptions) {
    this.config = opts.config
    this.handlers = opts.handlers ?? {}
    this.now = opts.now ?? Date.now
    this.logger =
      opts.logger ??
      createLogger({
        level: this.config.observability.logLevel as LogLevel,
        redactKeys: this.config.observability.redactKeys,
      })
    this.metrics = opts.metrics ?? createNoopMetrics()

    this.ws = new AgentchatWsClient({
      config: this.config,
      logger: this.logger,
      metrics: this.metrics,
      webSocketCtor: opts.webSocketCtor,
      now: opts.now,
      random: opts.random,
    })

    this.outbound = new OutboundAdapter({
      config: this.config,
      logger: this.logger,
      metrics: this.metrics,
      fetch: opts.fetch,
      now: opts.now,
      random: opts.random,
      sleep: opts.sleep,
      onBacklogWarning: (warning) => {
        try {
          this.handlers.onBacklogWarning?.(warning)
        } catch (err) {
          this.logger.error(
            { err: err instanceof Error ? err.message : String(err) },
            'onBacklogWarning handler threw',
          )
        }
      },
    })

    this.bindWsEvents()
  }

  /** Open the transport. Idempotent — subsequent calls are no-ops. */
  start(): void {
    if (this.started) return
    this.started = true
    this.ws.start()
  }

  /**
   * Graceful shutdown. Waits for outbound in-flight to drain up to the
   * deadline, then force-closes the WS. Returns a promise that resolves
   * once the WS has emitted `closed`.
   */
  stop(deadlineMs?: UnixMillis): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    const deadline = deadlineMs ?? this.now() + 5_000

    this.stopPromise = new Promise<void>((resolve) => {
      const off = this.ws.on('closed', () => {
        off()
        resolve()
      })
      this.ws.stop(deadline)
    })
    // Once outbound is idle, let the WS know it can close early.
    void this.pollUntilIdle(deadline)
    return this.stopPromise
  }

  private async pollUntilIdle(deadline: UnixMillis): Promise<void> {
    // Spin until outbound reports no in-flight + no queue, or we hit the
    // deadline. Cheap polling (10ms) is fine — in steady-state we expect
    // this to fire within tens of ms.
    const step = 10
    for (;;) {
      const snap = this.outbound.snapshot()
      if (snap.inFlight === 0 && snap.queued === 0) {
        this.ws.drainCompleted()
        return
      }
      if (this.now() >= deadline) return
      await new Promise((r) => setTimeout(r, step))
    }
  }

  /**
   * Send an outbound message. Delegates to the OutboundAdapter; callers
   * should handle `AgentChatChannelError` with class dispatch.
   */
  sendMessage(input: OutboundMessageInput): Promise<SendResult> {
    return this.outbound.sendMessage(input)
  }

  /** Push a client-action frame over the WS (typing, read-ack, presence). */
  sendWsAction(type: 'typing.start' | 'typing.stop' | 'message.read_ack' | 'presence.update', payload: Record<string, unknown>): boolean {
    return this.ws.send({ type, payload })
  }

  /**
   * Operator has rotated the API key — signal the WS client so it can
   * exit AUTH_FAIL. The caller is responsible for creating a new runtime
   * with the updated config OR for calling this after config hot-reload.
   */
  reconfigured(): void {
    this.ws.reconfigured()
  }

  getHealth(): HealthSnapshot {
    const outSnap = this.outbound.snapshot()
    return {
      state: this.ws.getState(),
      authenticated: this.authenticated,
      outbound: {
        inFlight: outSnap.inFlight,
        queued: outSnap.queued,
        circuitState: outSnap.circuit.state,
      },
    }
  }

  // ─── Internals ───────────────────────────────────────────────────────

  private bindWsEvents(): void {
    this.ws.on('stateChanged', (next, prev) => {
      if (next.kind !== 'READY' && next.kind !== 'DEGRADED') {
        this.authenticated = false
      }
      try {
        this.handlers.onStateChanged?.(next, prev)
      } catch (err) {
        this.logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          'onStateChanged handler threw',
        )
      }
    })

    this.ws.on('authenticated', (at) => {
      this.authenticated = true
      try {
        this.handlers.onAuthenticated?.(at)
      } catch (err) {
        this.logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          'onAuthenticated handler threw',
        )
      }
    })

    this.ws.on('inboundFrame', (frame) => {
      this.dispatchFrame(frame)
    })

    this.ws.on('error', (error) => {
      try {
        this.handlers.onError?.(error)
      } catch (err) {
        this.logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          'onError handler threw',
        )
      }
    })
  }

  private dispatchFrame(frame: InboundFrame): void {
    let normalized: NormalizedInbound
    try {
      normalized = normalizeInbound(frame)
    } catch (err) {
      if (err instanceof AgentChatChannelError) {
        this.logger.warn(
          { type: frame.type, class: err.class_, message: err.message },
          'inbound validation failed — dropping',
        )
        try {
          this.handlers.onValidationError?.(err, frame)
        } catch (handlerErr) {
          this.logger.error(
            { err: handlerErr instanceof Error ? handlerErr.message : String(handlerErr) },
            'onValidationError handler threw',
          )
        }
      } else {
        this.logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          'inbound normalizer threw unexpectedly',
        )
      }
      return
    }

    this.recordInboundMetric(normalized)

    try {
      const result = this.handlers.onInbound?.(normalized)
      if (result instanceof Promise) {
        result.catch((err) => {
          this.logger.error(
            { err: err instanceof Error ? err.message : String(err), type: normalized.kind },
            'async onInbound handler rejected',
          )
        })
      }
    } catch (err) {
      this.logger.error(
        { err: err instanceof Error ? err.message : String(err), type: normalized.kind },
        'onInbound handler threw',
      )
    }
  }

  private recordInboundMetric(n: NormalizedInbound): void {
    switch (n.kind) {
      case 'message':
        this.metrics.incInboundDelivered({
          kind: n.conversationKind === 'group' ? 'group-message' : 'message',
        })
        break
      case 'typing':
        this.metrics.incInboundDelivered({ kind: 'typing' })
        break
      case 'read-receipt':
        this.metrics.incInboundDelivered({ kind: 'read' })
        break
      case 'presence':
        this.metrics.incInboundDelivered({ kind: 'presence' })
        break
      case 'rate-limit-warning':
        this.metrics.incInboundDelivered({ kind: 'rate-limit-warning' })
        break
      case 'group-invite':
      case 'group-deleted':
      case 'unknown':
        // Not tracked — cardinality would explode on `unknown` kinds.
        break
    }
  }
}
