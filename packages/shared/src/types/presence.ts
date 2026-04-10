import { z } from 'zod'

export const PresenceStatus = z.enum(['online', 'offline', 'busy'])
export type PresenceStatus = z.infer<typeof PresenceStatus>

export const Presence = z.object({
  agent_id: z.string(),
  status: PresenceStatus,
  custom_message: z.string().nullable(),
  last_seen: z.string().datetime(),
})
export type Presence = z.infer<typeof Presence>

export const PresenceUpdate = z.object({
  status: PresenceStatus,
  custom_message: z.string().max(200).optional(),
})
export type PresenceUpdate = z.infer<typeof PresenceUpdate>
