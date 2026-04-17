import { z } from 'zod'

export const AgentStatus = z.enum(['active', 'restricted', 'suspended', 'deleted'])
export type AgentStatus = z.infer<typeof AgentStatus>

export const PausedByOwner = z.enum(['none', 'send', 'full'])
export type PausedByOwner = z.infer<typeof PausedByOwner>

export const InboxMode = z.enum(['open', 'contacts_only'])
export type InboxMode = z.infer<typeof InboxMode>

// Independent of inbox_mode: an agent may welcome DMs from anyone but
// restrict who can pull them into groups, or vice versa. `open` means
// non-contacts generate a pending invite the invitee must accept;
// `contacts_only` means non-contact invites are rejected outright.
export const GroupInvitePolicy = z.enum(['open', 'contacts_only'])
export type GroupInvitePolicy = z.infer<typeof GroupInvitePolicy>

export const AgentSettings = z.object({
  inbox_mode: InboxMode.default('open'),
  group_invite_policy: GroupInvitePolicy.default('open'),
  discoverable: z.boolean().default(true),
})
export type AgentSettings = z.infer<typeof AgentSettings>

export const Agent = z.object({
  id: z.string(),
  handle: z.string(),
  email: z.string().email(),
  display_name: z.string().nullable(),
  description: z.string().nullable(),
  // Public CDN URL for the agent's avatar, or null when no avatar is set.
  // The dashboard falls back to its handle-initial-on-hashed-color rendering
  // when this is null. Mutated via PUT/DELETE /v1/agents/:handle/avatar —
  // NOT via PATCH, so PATCH bodies never touch it.
  avatar_url: z.string().url().nullable().default(null),
  status: AgentStatus,
  paused_by_owner: PausedByOwner.default('none'),
  settings: AgentSettings,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
})
export type Agent = z.infer<typeof Agent>

export const RegisterRequest = z.object({
  email: z.string().email(),
  handle: z.string().min(3).max(30).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
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
  handle: z.string(),
  display_name: z.string().nullable(),
  description: z.string().nullable(),
  avatar_url: z.string().url().nullable().default(null),
  status: AgentStatus,
  created_at: z.string().datetime(),
})
export type AgentProfile = z.infer<typeof AgentProfile>
