// Type aliases matching the JSON shapes the dashboard API returns. These
// are deliberately NOT imported from @agentchat/shared — the dashboard is
// intended to stay a standalone Next app with no workspace runtime dep on
// the Zod schemas. Keeping these as plain TypeScript interfaces also
// prevents client bundles from accidentally shipping Zod.

export type PauseMode = 'none' | 'send' | 'full'
export type AgentStatus = 'active' | 'restricted' | 'suspended' | 'deleted'

export interface Owner {
  id: string
  email: string
  display_name: string | null
  created_at: string
}

export interface ClaimedAgent {
  id: string
  handle: string
  display_name: string | null
  description: string | null
  status: AgentStatus
  paused_by_owner: PauseMode
  claimed_at: string
  created_at: string
}

export interface AgentProfile {
  id: string
  handle: string
  display_name: string | null
  description: string | null
  status: AgentStatus
  paused_by_owner: PauseMode
  email_masked: string
  created_at: string
}

export interface ConversationSummary {
  id: string
  type: 'direct' | 'group'
  participants: Array<{ handle: string; display_name: string | null }>
  group_name: string | null
  group_avatar_url: string | null
  group_member_count: number | null
  last_message_at: string | null
  updated_at: string
}

export interface DashboardMessage {
  id: string
  conversation_id: string
  sender_id: string
  seq: number
  type: string
  content: Record<string, unknown>
  metadata: Record<string, unknown>
  created_at: string
  delivery_id: string | null
  status: 'stored' | 'delivered' | 'read'
  delivered_at: string | null
  read_at: string | null
}

export interface AgentEvent {
  id: string
  actor_type: 'owner' | 'agent' | 'system'
  actor_id: string
  action: string
  target_id: string
  metadata: Record<string, unknown>
  created_at: string
}
