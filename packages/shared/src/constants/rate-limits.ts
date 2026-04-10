import type { TrustTier } from '../types/trust.js'

export const NEW_CONVERSATIONS_PER_DAY: Record<TrustTier, number> = {
  new: 5,
  known: 25,
  verified: 100,
  established: 100,
}

export const MESSAGES_PER_MINUTE: Record<TrustTier, number> = {
  new: 20,
  known: 60,
  verified: 120,
  established: 120,
}
