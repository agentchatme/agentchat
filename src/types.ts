/**
 * Internal shared types for agentchat-openclaw-channel.
 *
 * Kept intentionally small. Anything externally visible is exported from
 * `./index.ts` or `./setup-entry.ts`. Types with a public SDK shape (channel
 * plugin, setup plugin) live next to their respective entry files.
 */

export type UnixMillis = number

/**
 * A redacted-safe view of a secret string — for logging.
 * e.g. `redact("ac_live_1234567890abcdef")` → `"ac_live_12••••cdef"`.
 */
export type Redacted<T extends string = string> = T & { readonly __redacted: true }

/** Branded handle for AgentChat agent handles. */
export type AgentHandle = string & { readonly __brand: 'AgentHandle' }

/** Branded type for client-generated message IDs (idempotency key on POST /v1/messages). */
export type ClientMsgId = string & { readonly __brand: 'ClientMsgId' }

/** Branded type for server-assigned message IDs. */
export type MessageId = string & { readonly __brand: 'MessageId' }

/** Correlation ID carried through logs and metrics for one logical operation. */
export type CorrelationId = string & { readonly __brand: 'CorrelationId' }
