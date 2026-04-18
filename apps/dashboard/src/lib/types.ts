// Type aliases matching the JSON shapes the dashboard API returns. These
// are deliberately NOT imported from @agentchat/shared — the dashboard is
// intended to stay a standalone Next app with no workspace runtime dep on
// the Zod schemas. Keeping these as plain TypeScript interfaces also
// prevents client bundles from accidentally shipping Zod.
//
// Internal row ids (agent.id, sender_id) are never exposed on the wire —
// every agent is addressed by @handle, every message ownership is
// surfaced as is_own. The server strips the internal fields in
// dashboard.service.ts.

export type PauseMode = 'none' | 'send' | 'full'
export type AgentStatus = 'active' | 'restricted' | 'suspended' | 'deleted'

export interface Owner {
  email: string
  display_name: string | null
  created_at: string
}

export interface ClaimedAgent {
  handle: string
  display_name: string | null
  description: string | null
  avatar_url: string | null
  status: AgentStatus
  paused_by_owner: PauseMode
  claimed_at: string
  created_at: string
}

export interface AgentProfile {
  handle: string
  display_name: string | null
  description: string | null
  avatar_url: string | null
  status: AgentStatus
  paused_by_owner: PauseMode
  email_masked: string
  created_at: string
}

export interface ConversationSummary {
  id: string
  type: 'direct' | 'group'
  participants: Array<{
    handle: string
    display_name: string | null
    avatar_url: string | null
  }>
  group_name: string | null
  group_avatar_url: string | null
  group_member_count: number | null
  last_message_at: string | null
  // Last-message preview fields. Optional because they were added in
  // a backend extension — when the dashboard is pointed at an older
  // api-server deploy these may be absent, and the conversation-list
  // falls back to the participant-handle subtitle.
  last_message_preview?: string | null
  last_message_is_own?: boolean
  last_message_type?: string | null
  updated_at: string
}

export interface DashboardMessage {
  id: string
  conversation_id: string
  is_own: boolean
  sender_handle: string | null
  sender_display_name: string | null
  sender_avatar_url: string | null
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

// Contact-book row as returned by /dashboard/agents/:handle/contacts.
// The `notes` field is a free-form string the agent writes about the
// contact (e.g. "met via group X") — surfaced read-only in the
// dashboard list.
export interface AgentContactRow {
  handle: string
  display_name: string | null
  description: string | null
  notes: string | null
  avatar_url: string | null
  added_at: string
}

// Block-list row as returned by /dashboard/agents/:handle/blocks.
// Soft-deleted blocked agents are filtered server-side so every row
// here points at a live handle.
export interface AgentBlockRow {
  handle: string
  display_name: string | null
  avatar_url: string | null
  blocked_at: string
}

export interface AgentEvent {
  id: string
  actor_type: 'owner' | 'agent' | 'system'
  action: string
  metadata: Record<string, unknown>
  created_at: string
}
