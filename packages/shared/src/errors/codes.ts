export const ErrorCode = {
  AGENT_NOT_FOUND: 'AGENT_NOT_FOUND',
  AGENT_SUSPENDED: 'AGENT_SUSPENDED',
  AGENT_PAUSED_BY_OWNER: 'AGENT_PAUSED_BY_OWNER',
  HANDLE_TAKEN: 'HANDLE_TAKEN',
  INVALID_HANDLE: 'INVALID_HANDLE',
  EMAIL_EXHAUSTED: 'EMAIL_EXHAUSTED',
  EMAIL_IS_OWNER: 'EMAIL_IS_OWNER',
  EMAIL_IS_AGENT: 'EMAIL_IS_AGENT',
  SUSPENDED: 'SUSPENDED',
  RESTRICTED: 'RESTRICTED',
  CONVERSATION_NOT_FOUND: 'CONVERSATION_NOT_FOUND',
  MESSAGE_NOT_FOUND: 'MESSAGE_NOT_FOUND',
  GROUP_DELETED: 'GROUP_DELETED',
  RATE_LIMITED: 'RATE_LIMITED',
  RECIPIENT_BACKLOGGED: 'RECIPIENT_BACKLOGGED',
  BLOCKED: 'BLOCKED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  WEBHOOK_DELIVERY_FAILED: 'WEBHOOK_DELIVERY_FAILED',
  OWNER_NOT_FOUND: 'OWNER_NOT_FOUND',
  INVALID_API_KEY: 'INVALID_API_KEY',
  ALREADY_CLAIMED: 'ALREADY_CLAIMED',
  CLAIM_NOT_FOUND: 'CLAIM_NOT_FOUND',
  // System-agent class exemptions (migration 040). Returned when a caller
  // tries to block/report/delete/claim chatfather or any future system
  // agent. Surfaced as 409 — the action is not forbidden by authorization,
  // it's structurally impossible on a system-class target.
  SYSTEM_AGENT_PROTECTED: 'SYSTEM_AGENT_PROTECTED',
  // Internal-only endpoints (e.g. /internal/rotate-system-agent-key) reject
  // with this when the ops bearer token is missing, malformed, or stale.
  OPS_AUTH_REQUIRED: 'OPS_AUTH_REQUIRED',
} as const

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

export interface ApiError {
  code: ErrorCode
  message: string
  details?: Record<string, unknown>
}
