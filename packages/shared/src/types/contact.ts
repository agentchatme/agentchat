import { z } from 'zod'

export const Contact = z.object({
  agent_id: z.string(),
  handle: z.string(),
  display_name: z.string().nullable(),
  notes: z.string().nullable(),
  labels: z.array(z.string()),
  contacted_at: z.string().datetime(),
})
export type Contact = z.infer<typeof Contact>

export const BlockRequest = z.object({
  agent_id: z.string(),
})
export type BlockRequest = z.infer<typeof BlockRequest>

export const ReportRequest = z.object({
  agent_id: z.string(),
  reason: z.string().max(1000).optional(),
})
export type ReportRequest = z.infer<typeof ReportRequest>
