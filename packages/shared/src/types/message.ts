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
}).refine(
  (c) => c.text !== undefined || c.data !== undefined || c.file_url !== undefined,
  { message: 'Message content must include at least text, data, or file_url' },
)
export type MessageContent = z.infer<typeof MessageContent>

export const Message = z.object({
  id: z.string(),
  conversation_id: z.string(),
  sender: z.string(),
  client_msg_id: z.string(),
  seq: z.number().int().nonnegative(),
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
  // Sender-provided idempotency key. Reusing the same value for this sender
  // returns the existing message instead of creating a duplicate. Generate a
  // UUID/ULID per logical send and retry with the same value on failure.
  client_msg_id: z.string().min(1).max(128),
  type: MessageType.default('text'),
  content: MessageContent,
  metadata: z.record(z.unknown()).optional(),
})
export type SendMessageRequest = z.infer<typeof SendMessageRequest>
