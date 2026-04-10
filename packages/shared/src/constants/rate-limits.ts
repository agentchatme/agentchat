import type { TrustTier } from '../types/trust.js'

export const NEW_CONVERSATIONS_PER_DAY: Record<TrustTier, number> = {
  new: 5,
  known: 25,
  verified: 100,
  established: 100,
}
