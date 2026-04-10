import { z } from 'zod'

export const MessageType = z.enum(['text', 'structured', 'file', 'system'])
export type MessageType = z.infer<typeof MessageType>

export const MessageStatus = z.enum(['stored', 'delivered', 'read'])
export type MessageStatus = z.infer<typeof MessageStatus>

export const MessageContent = z.object({
  text: z.string().optional(),
  data: z.record(z.unknown()).optional(),
  file_url: z.string().url().optional(),
  file_name: z.string().optional(),
  mime_type: z.string().optional(),
})
export type MessageContent = z.infer<typeof MessageContent>

export const Message = z.object({
  id: z.string(),
  conversation_id: z.string(),
  sender_id: z.string(),
  type: MessageType,
  content: MessageContent,
  metadata: z.record(z.unknown()).default({}),
  status: MessageStatus,
  created_at: z.string().datetime(),
  delivered_at: z.string().datetime().nullable(),
  read_at: z.string().datetime().nullable(),
})
export type Message = z.infer<typeof Message>

export const SendMessageRequest = z.object({
  to: z.string(),
  type: MessageType.default('text'),
  content: MessageContent,
  metadata: z.record(z.unknown()).optional(),
})
export type SendMessageRequest = z.infer<typeof SendMessageRequest>
