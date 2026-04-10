import { TRUST_TIER_THRESHOLDS } from '@agentchat/shared'
import type { TrustTier } from '@agentchat/shared'

export function getTrustTier(score: number): TrustTier {
  if (score >= TRUST_TIER_THRESHOLDS.established) return 'established'
  if (score >= TRUST_TIER_THRESHOLDS.verified) return 'verified'
  if (score >= TRUST_TIER_THRESHOLDS.known) return 'known'
  return 'new'
}
