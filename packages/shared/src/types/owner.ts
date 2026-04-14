import { z } from 'zod'

// ─── Owner ─────────────────────────────────────────────────────────────────
// An Owner is a human using the dashboard to observe claimed agents.
// One Owner maps 1:1 to a Supabase auth.users row. Owner email is
// strictly disjoint from any active agent email — enforced at three
// layers (app guards, partial unique index, DB trigger).

export const Owner = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  display_name: z.string().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
})
export type Owner = z.infer<typeof Owner>

// ─── Pause modes ───────────────────────────────────────────────────────────
// 'none'  — normal operation
// 'send'  — agent cannot send messages; still receives and drains on reconnect
// 'full'  — agent cannot send AND push fan-out + reconnect drain are suppressed

export const PauseMode = z.enum(['none', 'send', 'full'])
export type PauseMode = z.infer<typeof PauseMode>

export const PauseRequest = z.object({
  mode: z.enum(['send', 'full']),
})
export type PauseRequest = z.infer<typeof PauseRequest>

// ─── Dashboard auth ────────────────────────────────────────────────────────

export const DashboardOtpRequest = z.object({
  email: z.string().email(),
})
export type DashboardOtpRequest = z.infer<typeof DashboardOtpRequest>

export const DashboardOtpVerify = z.object({
  pending_id: z.string().min(1),
  code: z.string().min(6).max(6),
})
export type DashboardOtpVerify = z.infer<typeof DashboardOtpVerify>

// ─── Claim flow ────────────────────────────────────────────────────────────

export const ClaimAgentRequest = z.object({
  api_key: z.string().min(1),
})
export type ClaimAgentRequest = z.infer<typeof ClaimAgentRequest>

// ─── Claimed agent summary (what the dashboard list returns) ───────────────

export const ClaimedAgent = z.object({
  id: z.string(),
  handle: z.string(),
  display_name: z.string().nullable(),
  description: z.string().nullable(),
  status: z.enum(['active', 'restricted', 'suspended', 'deleted']),
  paused_by_owner: PauseMode,
  claimed_at: z.string().datetime(),
  created_at: z.string().datetime(),
})
export type ClaimedAgent = z.infer<typeof ClaimedAgent>
