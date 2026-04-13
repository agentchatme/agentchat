import { z } from 'zod'

export const ConversationType = z.enum(['direct', 'group'])
export type ConversationType = z.infer<typeof ConversationType>

export const Conversation = z.object({
  id: z.string(),
  type: ConversationType,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  last_message_at: z.string().datetime().nullable(),
})
export type Conversation = z.infer<typeof Conversation>

// Shared shape for both direct and group conversations in the list view.
// For direct conversations, `participants` has exactly the counterparty (and
// is empty only if the other side has been purged); group fields are null.
// For groups, the group fields are populated and `participants` is left
// empty — clients fetch the full member list on demand from the group
// detail endpoint. This keeps the list response bounded even when an agent
// is in many 100-member groups.
export const ConversationListItem = z.object({
  id: z.string(),
  type: ConversationType,
  participants: z.array(z.object({
    handle: z.string(),
    display_name: z.string().nullable(),
  })),
  group_name: z.string().nullable(),
  group_avatar_url: z.string().nullable(),
  group_member_count: z.number().int().nonnegative().nullable(),
  last_message_at: z.string().datetime().nullable(),
  updated_at: z.string().datetime(),
})
export type ConversationListItem = z.infer<typeof ConversationListItem>
