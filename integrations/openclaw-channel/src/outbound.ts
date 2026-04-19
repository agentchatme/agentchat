/**
 * Outbound adapter — OpenClaw send → AgentChat `POST /v1/messages`.
 *
 * Pipeline (left to right, each step is independently observable):
 *   1. Caller invokes `sendMessage(input)` with a channel-neutral shape.
 *   2. We derive a stable `client_msg_id` (idempotency key). If the caller
 *      supplied one, we respect it; otherwise we mint a UUID.
 *   3. Circuit-breaker precheck. Open circuit → fast-fail `retry-transient`.
 *   4. `retryWithPolicy(...)` wraps the actual HTTP call.
 *   5. On success, metrics/logs + return the `Message` the server minted.
 *   6. On 409 (idempotent-replay), treat as success with the replay body.
 *   7. On 429, honor `Retry-After` (seconds or HTTP-date) via the retry
 *      policy. Surface as `retry-rate`.
 *   8. On 5xx / network flap, retry with jittered exponential backoff.
 *   9. On 4xx other than 429/409, classify as `terminal-user` → no retry.
 *   10. On 401/403 → `terminal-auth`. We signal upstream so the WS client
 *       moves to AUTH_FAIL and the operator gets paged.
 *
 * Backpressure:
 *   - An in-flight semaphore bounds concurrent sends to `outbound.maxInFlight`.
 *   - Over-threshold sends are enqueued and drained as capacity frees up.
 *   - Queue has its own hard cap (`10 * maxInFlight`); over-cap sends reject
 *     immediately with `retry-transient` so the caller can shed load rather
 *     than OOM.
 */

import type { Message } from 'agentchat'

import { AgentChatChannelError, classifyHttpStatus, classifyNetworkError, parseRetryAfter } from './errors.js'
import type { Logger } from './log.js'
import type { MetricsRecorder } from './metrics.js'
import { CircuitBreaker, retryWithPolicy, type CircuitBreakerOptions, type RetryPolicy } from './retry.js'
import type { AgentchatChannelConfig } from './config-schema.js'
import type { UnixMillis } from './types.js'
import { PACKAGE_VERSION } from './version.js'

// ─── Types ─────────────────────────────────────────────────────────────

export type OutboundMessageInput =
  | OutboundDirectMessage
  | OutboundGroupMessage

export interface OutboundMessageBase {
  /**
   * Client-generated idempotency key. Optional — we mint one if absent.
   * Retries of the same logical send MUST reuse the same value or you'll
   * get duplicates.
   */
  readonly clientMsgId?: string
  readonly type?: 'text' | 'structured' | 'file'
  readonly content: {
    readonly text?: string
    readonly data?: Record<string, unknown>
    readonly attachmentId?: string
  }
  readonly metadata?: Record<string, unknown>
  /** Correlation id carried through logs and metrics. */
  readonly correlationId?: string
}

export interface OutboundDirectMessage extends OutboundMessageBase {
  readonly kind: 'direct'
  /** Recipient handle (e.g. "alice"). */
  readonly to: string
}

export interface OutboundGroupMessage extends OutboundMessageBase {
  readonly kind: 'group'
  /** `grp_*` conversation id. */
  readonly conversationId: string
}

export interface OutboundBacklogWarning {
  readonly recipientHandle: string
  readonly undeliveredCount: number
}

export interface SendResult {
  readonly message: Message
  readonly backlogWarning: OutboundBacklogWarning | null
  readonly idempotentReplay: boolean
  readonly attempts: number
  readonly latencyMs: number
  readonly requestId: string | null
}

export interface OutboundAdapterOptions {
  readonly config: AgentchatChannelConfig
  readonly logger: Logger
  readonly metrics: MetricsRecorder
  readonly fetch?: typeof fetch
  readonly now?: () => UnixMillis
  readonly random?: () => number
  readonly sleep?: (ms: number) => Promise<void>
  readonly circuitBreaker?: CircuitBreakerOptions
  readonly retryPolicy?: Partial<RetryPolicy>
  /** Surface backlog warnings to upstream — optional observability hook. */
  readonly onBacklogWarning?: (warning: OutboundBacklogWarning) => void
}

const DEFAULT_RETRY_POLICY: Omit<RetryPolicy, 'now' | 'random' | 'sleep'> = {
  maxAttempts: 4,
  initialBackoffMs: 250,
  maxBackoffMs: 10_000,
  jitterRatio: 0.3,
}

const DEFAULT_CIRCUIT_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 10,
  windowMs: 60_000,
  cooldownMs: 30_000,
}

// ─── Adapter ───────────────────────────────────────────────────────────

export class OutboundAdapter {
  private readonly config: AgentchatChannelConfig
  private readonly logger: Logger
  private readonly metrics: MetricsRecorder
  private readonly fetchImpl: typeof fetch
  private readonly now: () => UnixMillis
  private readonly breaker: CircuitBreaker
  private readonly retryPolicy: RetryPolicy
  private readonly onBacklogWarning?: (warning: OutboundBacklogWarning) => void

  // Backpressure bookkeeping.
  private inFlight = 0
  private readonly queue: Array<() => void> = []
  private readonly queueHardCap: number

  constructor(opts: OutboundAdapterOptions) {
    this.config = opts.config
    this.logger = opts.logger.child({ component: 'outbound' })
    this.metrics = opts.metrics
    this.fetchImpl = opts.fetch ?? fetch
    this.now = opts.now ?? Date.now
    this.onBacklogWarning = opts.onBacklogWarning
    this.breaker = new CircuitBreaker(opts.circuitBreaker ?? DEFAULT_CIRCUIT_OPTIONS)
    this.retryPolicy = {
      ...DEFAULT_RETRY_POLICY,
      ...opts.retryPolicy,
      now: opts.now,
      random: opts.random,
      sleep: opts.sleep,
    }
    this.queueHardCap = Math.max(10, this.config.outbound.maxInFlight * 10)
  }

  /**
   * Send a message. Returns on success; throws `AgentChatChannelError` on
   * terminal or exhausted-retry failure. The returned `SendResult.message`
   * is the row the server minted (or echoed back on idempotent replay).
   */
  async sendMessage(input: OutboundMessageInput): Promise<SendResult> {
    const clientMsgId = input.clientMsgId ?? this.mintClientMsgId()
    const correlationId = input.correlationId ?? clientMsgId
    const log = this.logger.child({ clientMsgId, correlationId, kind: input.kind })

    const precheck = this.breaker.precheck()
    if (!precheck.allow) {
      this.metrics.incOutboundFailed({ errorClass: 'retry-transient' })
      throw new AgentChatChannelError('retry-transient', precheck.reason)
    }

    await this.acquireSlot()
    const startedAt = this.now()
    try {
      const outcome = await retryWithPolicy(
        (attempt) => this.sendOnce({ input, clientMsgId, attempt, log }),
        this.retryPolicy,
      )
      const endedAt = this.now()
      this.breaker.onSuccess()
      this.metrics.incOutboundSent({ kind: 'message' })
      this.metrics.observeSendLatency(endedAt - startedAt)
      return {
        ...outcome.result,
        attempts: outcome.attempts,
        latencyMs: endedAt - startedAt,
      }
    } catch (err) {
      if (err instanceof AgentChatChannelError) {
        this.breaker.onFailure(err.class_)
        this.metrics.incOutboundFailed({ errorClass: err.class_ })
        log.warn(
          { class: err.class_, status: err.statusCode, msg: err.message },
          'send failed',
        )
      } else {
        this.metrics.incOutboundFailed({ errorClass: 'retry-transient' })
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          'send failed — unexpected error',
        )
      }
      throw err
    } finally {
      this.releaseSlot()
    }
  }

  /** Current state for observability / health checks. */
  snapshot(): { inFlight: number; queued: number; circuit: ReturnType<CircuitBreaker['snapshot']> } {
    return {
      inFlight: this.inFlight,
      queued: this.queue.length,
      circuit: this.breaker.snapshot(),
    }
  }

  // ─── Internals ───────────────────────────────────────────────────────

  private async sendOnce(args: {
    input: OutboundMessageInput
    clientMsgId: string
    attempt: number
    log: Logger
  }): Promise<Omit<SendResult, 'attempts' | 'latencyMs'>> {
    const { input, clientMsgId, attempt, log } = args
    const body = this.buildBody(input, clientMsgId)
    const url = `${this.config.apiBase}/v1/messages`
    const headers: Record<string, string> = {
      'authorization': `Bearer ${this.config.apiKey}`,
      'content-type': 'application/json',
      'user-agent': `agentchat-openclaw-channel/${PACKAGE_VERSION} (+attempt=${attempt})`,
    }

    let res: Response
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
    } catch (err) {
      throw new AgentChatChannelError(
        classifyNetworkError(err),
        `POST /v1/messages network error: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      )
    }

    const requestId = res.headers.get('x-request-id')
    const idempotentReplay = res.headers.get('idempotent-replay') === 'true'
    const backlogWarning = this.parseBacklogWarning(res.headers.get('x-backlog-warning'))

    if (res.ok) {
      const message = (await res.json().catch(() => null)) as Message | null
      if (!message || typeof message !== 'object') {
        throw new AgentChatChannelError(
          'validation',
          'POST /v1/messages returned non-JSON success body',
          { statusCode: res.status },
        )
      }
      if (idempotentReplay) {
        log.info({ status: res.status, requestId }, 'idempotent replay — server echoed existing message')
      }
      if (backlogWarning && this.onBacklogWarning) {
        try {
          this.onBacklogWarning(backlogWarning)
        } catch (err) {
          // Handler errors must not break send, but silent swallow leaves
          // operators blind — log it so the failure is at least diagnosable.
          log.error(
            { err: err instanceof Error ? err.message : String(err) },
            'onBacklogWarning handler threw — swallowed to protect send path',
          )
        }
      }
      return { message, backlogWarning, idempotentReplay, requestId }
    }

    // 2xx-none-of-the-above path: parse error body, classify, throw.
    const errorBody = await res.json().catch(() => null)
    const retryAfter = parseRetryAfter(res.headers.get('retry-after'), this.now())
    const errorClass = classifyHttpStatus(res.status, res.headers.get('retry-after'))
    const serverMessage =
      (errorBody as { message?: unknown } | null)?.message ?? `HTTP ${res.status}`
    throw new AgentChatChannelError(
      errorClass,
      typeof serverMessage === 'string' ? serverMessage : `HTTP ${res.status}`,
      {
        statusCode: res.status,
        retryAfterMs: retryAfter,
      },
    )
  }

  private buildBody(input: OutboundMessageInput, clientMsgId: string): Record<string, unknown> {
    const content: Record<string, unknown> = {}
    if (input.content.text !== undefined) content.text = input.content.text
    if (input.content.data !== undefined) content.data = input.content.data
    if (input.content.attachmentId !== undefined) content.attachment_id = input.content.attachmentId

    if (Object.keys(content).length === 0) {
      throw new AgentChatChannelError(
        'terminal-user',
        'outbound message has empty content — at least one of text/data/attachmentId required',
      )
    }

    const body: Record<string, unknown> = {
      client_msg_id: clientMsgId,
      content,
    }
    if (input.type) body.type = input.type
    if (input.metadata) body.metadata = input.metadata
    if (input.kind === 'direct') body.to = input.to
    else body.conversation_id = input.conversationId
    return body
  }

  private parseBacklogWarning(header: string | null): OutboundBacklogWarning | null {
    if (!header) return null
    const eq = header.indexOf('=')
    if (eq <= 0 || eq === header.length - 1) return null
    const recipientHandle = header.slice(0, eq).trim()
    const countStr = header.slice(eq + 1).trim()
    const undeliveredCount = Number(countStr)
    if (!recipientHandle) return null
    if (!Number.isFinite(undeliveredCount) || !Number.isInteger(undeliveredCount)) return null
    return { recipientHandle, undeliveredCount }
  }

  private mintClientMsgId(): string {
    const cryptoObj = (globalThis as { crypto?: Crypto }).crypto
    if (cryptoObj?.randomUUID) return cryptoObj.randomUUID()
    return `cmsg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`
  }

  // ─── Backpressure ────────────────────────────────────────────────────

  private async acquireSlot(): Promise<void> {
    if (this.inFlight < this.config.outbound.maxInFlight) {
      this.inFlight++
      this.metrics.setInFlightDepth(this.inFlight)
      return
    }
    if (this.queue.length >= this.queueHardCap) {
      throw new AgentChatChannelError(
        'retry-transient',
        `outbound queue full (${this.queue.length}) — shedding load`,
      )
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.inFlight++
        this.metrics.setInFlightDepth(this.inFlight)
        resolve()
      })
    })
  }

  private releaseSlot(): void {
    this.inFlight = Math.max(0, this.inFlight - 1)
    this.metrics.setInFlightDepth(this.inFlight)
    const next = this.queue.shift()
    if (next) next()
  }
}
