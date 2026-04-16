import { z } from 'zod'

export const PresenceStatus = z.enum(['online', 'offline', 'busy'])
export type PresenceStatus = z.infer<typeof PresenceStatus>

export const Presence = z.object({
  handle: z.string(),
  status: PresenceStatus,
  custom_message: z.string().nullable(),
  last_seen: z.string().datetime().nullable(),
})
export type Presence = z.infer<typeof Presence>

export const PresenceUpdate = z.object({
  status: PresenceStatus,
  custom_message: z.string().max(200).optional(),
})
export type PresenceUpdate = z.infer<typeof PresenceUpdate>

/** POST /v1/presence/batch — query up to 100 handles at once */
export const PresenceBatchRequest = z.object({
  handles: z.array(z.string()).min(1).max(100),
})
export type PresenceBatchRequest = z.infer<typeof PresenceBatchRequest>

/** Wire shape pushed over WS on presence.update events */
export const PresenceBroadcast = z.object({
  handle: z.string(),
  status: PresenceStatus,
  custom_message: z.string().nullable(),
})
export type PresenceBroadcast = z.infer<typeof PresenceBroadcast>
