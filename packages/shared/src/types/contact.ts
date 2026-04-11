import { z } from 'zod'

export const AddContactRequest = z.object({
  handle: z.string(),
})
export type AddContactRequest = z.infer<typeof AddContactRequest>

export const ReportRequest = z.object({
  reason: z.string().max(1000).optional(),
})
export type ReportRequest = z.infer<typeof ReportRequest>
