export type ConversationType = 'direct' | 'group'

export interface Conversation {
  id: string
  type: ConversationType
  created_at: string
  updated_at: string
  last_message_at: string | null
}

export interface ConversationParticipant {
  handle: string
  display_name: string | null
}

/**
 * Unified row shape for both direct and group conversations.
 *
 * - For direct conversations: `participants` has exactly the counterparty
 *   (empty only if the other side has been purged) and the group fields
 *   are `null`.
 * - For groups: `group_name`, `group_avatar_url`, and `group_member_count`
 *   are populated and `participants` is `[]`. Fetch the full member list
 *   on demand via `getGroup(id)`.
 */
export interface ConversationListItem {
  id: string
  type: ConversationType
  participants: ConversationParticipant[]
  group_name: string | null
  group_avatar_url: string | null
  group_member_count: number | null
  last_message_at: string | null
  updated_at: string
  is_muted: boolean
}
