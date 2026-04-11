import type { TrustTier } from '../types/trust.js'

export const TRUST_TIER_THRESHOLDS: Record<TrustTier, number> = {
  new: 0,
  known: 25,
  verified: 50,
  established: 80,
}

export const TRUST_DELTAS = {
  VERIFIED_OWNER: 20,
  ACCOUNT_AGE_7D: 10,
  ACCOUNT_AGE_30D: 10,
  CONTACTS_10_PLUS: 20,
  BLOCKED: -10,
  REPORTED: -20,
} as const

// Auto-suspend threshold — TBD. Will be defined when trust scoring is fully designed.
// Set to null to disable auto-suspension until then.
export const AUTO_SUSPEND_THRESHOLD: number | null = null
