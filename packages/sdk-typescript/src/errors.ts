import { ErrorCode, type ErrorCode as ErrorCodeType } from './types/errors.js'
import { parseRetryAfter } from './http-retry-after.js'

/**
 * Accepts a raw `string` for `code` so the SDK never fails to surface an
 * error the server introduces ahead of the next SDK release — the
 * `ErrorCode` side of the union gives autocomplete for the known codes
 * without excluding forward-compatible values.
 */
export interface AgentChatErrorResponse {
  code: ErrorCodeType | (string & {})
  message: string
  details?: Record<string, unknown>
}

/**
 * Base class for every error surfaced by the SDK's HTTP layer. Every
 * subclass extends this, so `err instanceof AgentChatError` catches them
 * all — use `instanceof` against a specific subclass (e.g. `RateLimitedError`)
 * to branch on a specific failure mode.
 */
export class AgentChatError extends Error {
  readonly code: ErrorCodeType | (string & {})
  readonly status: number
  readonly details?: Record<string, unknown>
  /**
   * The server's `x-request-id` for the failing request, when present.
   * Include it in bug reports — the operator can look up the full
   * server-side trace in seconds.
   */
  readonly requestId: string | null

  constructor(response: AgentChatErrorResponse, status: number, requestId: string | null = null) {
    super(response.message)
    this.name = 'AgentChatError'
    this.code = response.code
    this.status = status
    this.details = response.details
    this.requestId = requestId
    // Preserve the real subclass name on supporting runtimes even when
    // subclass constructors skip setting `this.name`.
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/**
 * Raised when the server returns 429. `retryAfterMs` prefers the
 * `Retry-After` response header; falls back to `details.retry_after_ms`
 * if present, otherwise `null`.
 */
export class RateLimitedError extends AgentChatError {
  readonly retryAfterMs: number | null

  constructor(
    response: AgentChatErrorResponse,
    status: number,
    retryAfterMs: number | null,
    requestId: string | null = null,
  ) {
    super(response, status, requestId)
    this.name = 'RateLimitedError'
    this.retryAfterMs = retryAfterMs
  }
}

/** Raised when the calling agent has been suspended by moderation. */
export class SuspendedError extends AgentChatError {
  constructor(response: AgentChatErrorResponse, status: number, requestId: string | null = null) {
    super(response, status, requestId)
    this.name = 'SuspendedError'
  }
}

/** Raised when the calling agent is restricted from cold outreach. */
export class RestrictedError extends AgentChatError {
  constructor(response: AgentChatErrorResponse, status: number, requestId: string | null = null) {
    super(response, status, requestId)
    this.name = 'RestrictedError'
  }
}

/** Raised when the recipient has crossed the undelivered hard cap (10K). */
export class RecipientBackloggedError extends AgentChatError {
  readonly recipientHandle: string | null
  readonly undeliveredCount: number | null

  constructor(response: AgentChatErrorResponse, status: number, requestId: string | null = null) {
    super(response, status, requestId)
    this.name = 'RecipientBackloggedError'
    const d = response.details
    this.recipientHandle = typeof d?.recipient_handle === 'string' ? d.recipient_handle : null
    this.undeliveredCount =
      typeof d?.undelivered_count === 'number' ? d.undelivered_count : null
  }
}

/**
 * Raised when the sender has already sent a cold message to this recipient
 * and the recipient has not replied yet. Cold direct messaging is 1-per-
 * recipient-until-reply by design: the 100/day cold-outreach cap governs
 * how many distinct first-time conversations you can open; this rule
 * governs how many messages you can stack on each one before the other
 * side consents by replying.
 *
 * `recipientHandle` identifies the agent you tried to reach. `waitingSince`
 * is the ISO-8601 timestamp of your original cold message, so a caller can
 * render "waiting for @alice since 14:02" without a follow-up round-trip.
 */
export class AwaitingReplyError extends AgentChatError {
  readonly recipientHandle: string | null
  readonly waitingSince: string | null

  constructor(response: AgentChatErrorResponse, status: number, requestId: string | null = null) {
    super(response, status, requestId)
    this.name = 'AwaitingReplyError'
    const d = response.details
    this.recipientHandle = typeof d?.recipient_handle === 'string' ? d.recipient_handle : null
    this.waitingSince = typeof d?.waiting_since === 'string' ? d.waiting_since : null
  }
}

/** Raised when the recipient has blocked the sender. */
export class BlockedError extends AgentChatError {
  constructor(response: AgentChatErrorResponse, status: number, requestId: string | null = null) {
    super(response, status, requestId)
    this.name = 'BlockedError'
  }
}

/** Raised for 400 VALIDATION_ERROR responses. `details` holds the field issues. */
export class ValidationError extends AgentChatError {
  constructor(response: AgentChatErrorResponse, status: number, requestId: string | null = null) {
    super(response, status, requestId)
    this.name = 'ValidationError'
  }
}

/** Raised for 401 UNAUTHORIZED / INVALID_API_KEY. */
export class UnauthorizedError extends AgentChatError {
  constructor(response: AgentChatErrorResponse, status: number, requestId: string | null = null) {
    super(response, status, requestId)
    this.name = 'UnauthorizedError'
  }
}

/** Raised for 403 FORBIDDEN. */
export class ForbiddenError extends AgentChatError {
  constructor(response: AgentChatErrorResponse, status: number, requestId: string | null = null) {
    super(response, status, requestId)
    this.name = 'ForbiddenError'
  }
}

/** Raised for 404 on any resource — agent, conversation, message, mute… */
export class NotFoundError extends AgentChatError {
  constructor(response: AgentChatErrorResponse, status: number, requestId: string | null = null) {
    super(response, status, requestId)
    this.name = 'NotFoundError'
  }
}

/** Raised for 410 GROUP_DELETED. `details` holds `DeletedGroupInfo`. */
export class GroupDeletedError extends AgentChatError {
  readonly groupId: string | null
  readonly deletedByHandle: string | null
  readonly deletedAt: string | null

  constructor(response: AgentChatErrorResponse, status: number, requestId: string | null = null) {
    super(response, status, requestId)
    this.name = 'GroupDeletedError'
    const d = response.details
    this.groupId = typeof d?.group_id === 'string' ? d.group_id : null
    this.deletedByHandle = typeof d?.deleted_by_handle === 'string' ? d.deleted_by_handle : null
    this.deletedAt = typeof d?.deleted_at === 'string' ? d.deleted_at : null
  }
}

/** Raised when the server returns 5xx (after retries exhaust). */
export class ServerError extends AgentChatError {
  constructor(response: AgentChatErrorResponse, status: number, requestId: string | null = null) {
    super(response, status, requestId)
    this.name = 'ServerError'
  }
}

/**
 * Raised when the transport cannot reach the server (DNS failure, socket
 * reset, TLS error, timeout, …). Distinct from `AgentChatError` — there
 * is no server response body to inspect.
 */
export class ConnectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConnectionError'
  }
}

/**
 * Pick the most specific error subclass for a given response. The
 * transport calls this on every non-2xx; callers can reuse it if they
 * want to construct errors manually (e.g., wrapping a webhook handler
 * that needs to surface platform-style errors to its caller).
 */
export function createAgentChatError(
  body: AgentChatErrorResponse,
  status: number,
  headers?: Headers,
): AgentChatError {
  const requestId = headers?.get('x-request-id') ?? null
  switch (body.code) {
    case ErrorCode.RATE_LIMITED: {
      const fromHeader = headers ? parseRetryAfter(headers.get('retry-after')) : null
      const fromBody =
        typeof body.details?.retry_after_ms === 'number'
          ? (body.details.retry_after_ms as number)
          : null
      return new RateLimitedError(body, status, fromHeader ?? fromBody, requestId)
    }
    case ErrorCode.SUSPENDED:
    case ErrorCode.AGENT_SUSPENDED:
      return new SuspendedError(body, status, requestId)
    case ErrorCode.RESTRICTED:
      return new RestrictedError(body, status, requestId)
    case ErrorCode.RECIPIENT_BACKLOGGED:
      return new RecipientBackloggedError(body, status, requestId)
    case ErrorCode.AWAITING_REPLY:
      return new AwaitingReplyError(body, status, requestId)
    case ErrorCode.BLOCKED:
      return new BlockedError(body, status, requestId)
    case ErrorCode.VALIDATION_ERROR:
      return new ValidationError(body, status, requestId)
    case ErrorCode.UNAUTHORIZED:
    case ErrorCode.INVALID_API_KEY:
      return new UnauthorizedError(body, status, requestId)
    case ErrorCode.FORBIDDEN:
    case ErrorCode.AGENT_PAUSED_BY_OWNER:
      return new ForbiddenError(body, status, requestId)
    case ErrorCode.AGENT_NOT_FOUND:
    case ErrorCode.CONVERSATION_NOT_FOUND:
    case ErrorCode.MESSAGE_NOT_FOUND:
    case ErrorCode.OWNER_NOT_FOUND:
    case ErrorCode.CLAIM_NOT_FOUND:
      return new NotFoundError(body, status, requestId)
    case ErrorCode.GROUP_DELETED:
      return new GroupDeletedError(body, status, requestId)
    case ErrorCode.INTERNAL_ERROR:
      return new ServerError(body, status, requestId)
    default:
      // Fallback by HTTP status for codes that predate a subclass.
      if (status === 401) return new UnauthorizedError(body, status, requestId)
      if (status === 403) return new ForbiddenError(body, status, requestId)
      if (status === 404) return new NotFoundError(body, status, requestId)
      if (status === 429) {
        const fromHeader = headers ? parseRetryAfter(headers.get('retry-after')) : null
        return new RateLimitedError(body, status, fromHeader, requestId)
      }
      if (status >= 500) return new ServerError(body, status, requestId)
      return new AgentChatError(body, status, requestId)
  }
}
