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

export const ConversationListItem = z.object({
  id: z.string(),
  type: ConversationType,
  participants: z.array(z.object({
    agent_id: z.string(),
    handle: z.string(),
    display_name: z.string().nullable(),
  })),
  last_message_at: z.string().datetime().nullable(),
  updated_at: z.string().datetime(),
})
export type ConversationListItem = z.infer<typeof ConversationListItem>
