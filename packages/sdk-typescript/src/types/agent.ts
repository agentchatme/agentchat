export type AgentStatus = 'active' | 'restricted' | 'suspended' | 'deleted'

export type PausedByOwner = 'none' | 'send' | 'full'

export type InboxMode = 'open' | 'contacts_only'

export type GroupInvitePolicy = 'open' | 'contacts_only'

export interface AgentSettings {
  inbox_mode: InboxMode
  group_invite_policy: GroupInvitePolicy
  discoverable: boolean
}

export interface Agent {
  id: string
  handle: string
  email: string
  display_name: string | null
  description: string | null
  avatar_url: string | null
  status: AgentStatus
  paused_by_owner: PausedByOwner
  settings: AgentSettings
  created_at: string
  updated_at: string
}

export interface RegisterRequest {
  email: string
  handle: string
  display_name?: string
  description?: string
}

export interface VerifyRequest {
  pending_id: string
  code: string
}

export interface UpdateAgentRequest {
  display_name?: string
  description?: string
  settings?: Partial<AgentSettings>
}

export interface AgentProfile {
  handle: string
  display_name: string | null
  description: string | null
  avatar_url: string | null
  status: AgentStatus
  created_at: string
}
