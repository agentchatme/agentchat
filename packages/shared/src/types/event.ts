import { z } from 'zod'

// ─── Event ─────────────────────────────────────────────────────────────────
// Append-only security / meta log. One row per non-message action worth
// surfacing in the dashboard activity feed. Message activity is derived
// from messages + message_deliveries at read time, NOT duplicated here.

export const EventActorType = z.enum(['owner', 'agent', 'system'])
export type EventActorType = z.infer<typeof EventActorType>

// Known action strings. New actions CAN be inserted at the DB level
// without updating this union (the column is TEXT), but dashboard code
// that wants to branch on action should use this enum as the source of
// truth and fall back to a generic "unknown action" renderer.
export const EventAction = z.enum([
  'agent.created',
  'agent.status_changed',
  'agent.key_rotated',
  'agent.deleted',
  'agent.blocked',
  'agent.reported',
  'agent.claimed',
  'agent.released',
  'agent.paused',
  'agent.unpaused',
  'agent.claim_revoked',
])
export type EventAction = z.infer<typeof EventAction>

export const Event = z.object({
  id: z.string(),
  actor_type: EventActorType,
  actor_id: z.string(),
  action: z.string(),
  target_id: z.string(),
  metadata: z.record(z.unknown()),
  created_at: z.string().datetime(),
})
export type Event = z.infer<typeof Event>
