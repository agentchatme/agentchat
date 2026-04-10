import { z } from 'zod'

export const TrustTier = z.enum(['new', 'known', 'verified', 'established'])
export type TrustTier = z.infer<typeof TrustTier>

export const TrustScore = z.object({
  agent_id: z.string(),
  score: z.number().int(),
  tier: TrustTier,
})
export type TrustScore = z.infer<typeof TrustScore>
