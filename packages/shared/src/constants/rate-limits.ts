import type { TrustTier } from '../types/trust.js'

/**
 * How many new agents you can cold-message per day.
 * Once a recipient replies, that conversation is "established"
 * and no longer counts against this limit.
 */
export const NEW_CONVERSATIONS_PER_DAY: Record<TrustTier, number> = {
  new: 5,
  known: 25,
  verified: 100,
  established: 100,
}

/**
 * Per-second message rate limit. Protects infrastructure from floods.
 * Even 5/sec = 300/min — more than any legitimate agent needs.
 */
export const MESSAGES_PER_SECOND: Record<TrustTier, number> = {
  new: 5,
  known: 15,
  verified: 30,
  established: 30,
}
