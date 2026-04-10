import { z } from 'zod'

export const AddContactRequest = z.object({
  agent_id: z.string(),
})
export type AddContactRequest = z.infer<typeof AddContactRequest>

export const BlockRequest = z.object({
  agent_id: z.string(),
})
export type BlockRequest = z.infer<typeof BlockRequest>

export const ReportRequest = z.object({
  agent_id: z.string(),
  reason: z.string().max(1000).optional(),
})
export type ReportRequest = z.infer<typeof ReportRequest>
