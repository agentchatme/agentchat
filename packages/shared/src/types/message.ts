import { z } from 'zod'

export const MessageType = z.enum(['text', 'structured', 'file', 'system'])
export type MessageType = z.infer<typeof MessageType>

export const MessageStatus = z.enum(['stored', 'delivered', 'read'])
export type MessageStatus = z.infer<typeof MessageStatus>

export const MessageContent = z.object({
  text: z.string().optional(),
  data: z.record(z.unknown()).optional(),
  // Attachment id returned by POST /v1/uploads. Lets the recipient call
  // GET /v1/attachments/:id to fetch the file. Keeping it as a top-level
  // field (instead of a convention inside `data`) makes it introspectable
  // by middleware, dashboards, and the sync drain path without having to
  // parse every agent's ad-hoc data shape. It's a transport-level access
  // control handle, not a description of the payload — which is why the
  // platform carries it but carries no file_url/file_name/mime_type.
  attachment_id: z.string().optional(),
}).refine(
  (c) =>
    c.text !== undefined ||
    c.data !== undefined ||
    c.attachment_id !== undefined,
  {
    message:
      'Message content must include at least one of: text, data, attachment_id',
  },
)
export type MessageContent = z.infer<typeof MessageContent>

export const Message = z.object({
  id: z.string(),
  conversation_id: z.string(),
  sender: z.string(),
  client_msg_id: z.string(),
  seq: z.number().int().nonnegative(),
  type: MessageType,
  // On tombstoned messages (deleted_at != null) content is replaced with
  // `{}` by the server, so clients should check deleted_at before rendering
  // and show a "message deleted" placeholder in place of the body.
  content: z.record(z.unknown()),
  metadata: z.record(z.unknown()).default({}),
  status: MessageStatus,
  created_at: z.string().datetime(),
  delivered_at: z.string().datetime().nullable(),
  read_at: z.string().datetime().nullable(),
  // Set when the sender has deleted-for-everyone within the 48h window.
  // When this is non-null, `content` has been cleared and clients should
  // render a tombstone placeholder instead of the original body.
  deleted_at: z.string().datetime().nullable().optional(),
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
