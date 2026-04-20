/**
 * Error taxonomy for the AgentChat channel plugin.
 *
 * Every error that crosses a pipeline boundary (inbound receive, outbound
 * send, config validation, transport) must be classifiable as one of:
 *
 *   terminal-auth       — 401/403. API key invalid or revoked. Do not retry.
 *                         Move state machine to AUTH_FAIL.
 *   terminal-user       — 400/422 (client-side validation). Bug in this plugin
 *                         or malformed outbound. Log at error level, drop,
 *                         do not retry.
 *   retry-rate          — 429. Retry after `retryAfterMs` (or jittered
 *                         exponential backoff if header absent).
 *   retry-transient     — 5xx, ECONNRESET, ETIMEDOUT, network flap.
 *                         Exponential backoff + jitter. Open circuit after N.
 *   idempotent-replay   — 409 on POST /v1/messages with duplicate
 *                         client_msg_id. Treat as success, log at info.
 *   validation          — Zod schema failed on inbound payload. Likely a
 *                         server change. Log at error, drop, alert.
 */

export type ErrorClass =
  | 'terminal-auth'
  | 'terminal-user'
  | 'retry-rate'
  | 'retry-transient'
  | 'idempotent-replay'
  | 'validation'

export class AgentChatChannelError extends Error {
  readonly class_: ErrorClass
  readonly retryAfterMs: number | undefined
  readonly statusCode: number | undefined

  constructor(
    class_: ErrorClass,
    message: string,
    options: {
      cause?: unknown
      retryAfterMs?: number
      statusCode?: number
    } = {},
  ) {
    super(message, { cause: options.cause })
    this.name = 'AgentChatChannelError'
    this.class_ = class_
    this.retryAfterMs = options.retryAfterMs
    this.statusCode = options.statusCode
  }
}

/** Classify an HTTP status code from the AgentChat REST API. */
export function classifyHttpStatus(status: number, retryAfterHeader?: string | null): ErrorClass {
  if (status === 401 || status === 403) return 'terminal-auth'
  if (status === 409) return 'idempotent-replay'
  if (status === 429) return 'retry-rate'
  if (status >= 500 && status <= 599) return 'retry-transient'
  if (status >= 400 && status <= 499) return 'terminal-user'
  return 'retry-transient' // unexpected — prefer retry over silent drop
}

/** Parse a `Retry-After` header to milliseconds. Accepts seconds or HTTP-date. */
export function parseRetryAfter(header: string | null | undefined, nowMs: number): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1000)
  const when = Date.parse(header)
  if (Number.isFinite(when)) return Math.max(0, when - nowMs)
  return undefined
}

/** Classify a low-level transport error (from `ws` or `fetch`). */
export function classifyNetworkError(err: unknown): ErrorClass {
  if (!err || typeof err !== 'object') return 'retry-transient'
  const code = (err as { code?: unknown }).code
  if (typeof code === 'string') {
    if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED') {
      return 'retry-transient'
    }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'retry-transient'
  }
  return 'retry-transient'
}

/** True iff the error class should trigger a retry. */
export function isRetryable(class_: ErrorClass): boolean {
  return class_ === 'retry-rate' || class_ === 'retry-transient'
}

/** True iff the error class is terminal (no retry, operator action needed). */
export function isTerminal(class_: ErrorClass): boolean {
  return class_ === 'terminal-auth' || class_ === 'terminal-user' || class_ === 'validation'
}
