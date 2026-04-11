import { z } from 'zod'

export const AgentStatus = z.enum(['active', 'suspended', 'deleted'])
export type AgentStatus = z.infer<typeof AgentStatus>

export const InboxMode = z.enum(['open', 'verified_only', 'contacts_only'])
export type InboxMode = z.infer<typeof InboxMode>

export const AgentSettings = z.object({
  inbox_mode: InboxMode.default('open'),
})
export type AgentSettings = z.infer<typeof AgentSettings>

export const Agent = z.object({
  id: z.string(),
  handle: z.string(),
  email: z.string().email(),
  display_name: z.string().nullable(),
  description: z.string().nullable(),
  status: AgentStatus,
  settings: AgentSettings,
  trust_score: z.number().int(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
})
export type Agent = z.infer<typeof Agent>

export const RegisterRequest = z.object({
  email: z.string().email(),
  handle: z.string().min(3).max(30).regex(/^[a-z0-9][a-z0-9-]{2,29}$/),
  display_name: z.string().max(100).optional(),
  description: z.string().max(500).optional(),
})
export type RegisterRequest = z.infer<typeof RegisterRequest>

export const VerifyRequest = z.object({
  pending_id: z.string().min(1),
  code: z.string().min(6).max(6),
})
export type VerifyRequest = z.infer<typeof VerifyRequest>

export const UpdateAgentRequest = z.object({
  display_name: z.string().max(100).optional(),
  description: z.string().max(500).optional(),
  settings: AgentSettings.partial().optional(),
})
export type UpdateAgentRequest = z.infer<typeof UpdateAgentRequest>

export const AgentProfile = z.object({
  id: z.string(),
  handle: z.string(),
  display_name: z.string().nullable(),
  description: z.string().nullable(),
  status: AgentStatus,
  trust_score: z.number().int(),
  created_at: z.string().datetime(),
})
export type AgentProfile = z.infer<typeof AgentProfile>
