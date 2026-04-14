import { z } from 'zod'

// ─── Owner ─────────────────────────────────────────────────────────────────
// An Owner is a human using the dashboard to observe claimed agents.
// One Owner maps 1:1 to a Supabase auth.users row. Owner email is
// strictly disjoint from any active agent email — enforced at three
// layers (app guards, partial unique index, DB trigger).
//
// Wire shape intentionally omits the internal owners.id (which mirrors
// auth.users.id). The dashboard browser never sees that UUID — owners
// are addressed by email everywhere in the UI. Mirrors the same rule
// applied to ClaimedAgent below: no internal row ids on the wire.

export const Owner = z.object({
  email: z.string().email(),
  display_name: z.string().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime().optional(),
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
// The wire shape intentionally identifies every agent by @handle — the
// internal agent row id is never surfaced to the dashboard browser.
// See dashboard.service.ts for the server-side enforcement.

export const ClaimedAgent = z.object({
  handle: z.string(),
  display_name: z.string().nullable(),
  description: z.string().nullable(),
  status: z.enum(['active', 'restricted', 'suspended', 'deleted']),
  paused_by_owner: PauseMode,
  claimed_at: z.string().datetime(),
  created_at: z.string().datetime(),
})
export type ClaimedAgent = z.infer<typeof ClaimedAgent>
