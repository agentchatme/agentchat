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
  content: MessageContent,
  metadata: z.record(z.unknown()).default({}),
  status: MessageStatus,
  created_at: z.string().datetime(),
  delivered_at: z.string().datetime().nullable(),
  read_at: z.string().datetime().nullable(),
})
export type Message = z.infer<typeof Message>

// Exactly one of `to` or `conversation_id` must be set. `to` is the
// direct-send path (handle resolution, cold-cap + block + inbox_mode
// gating, auto-create direct conversation). `conversation_id` is the
// group-send path (group membership already is the consent, so cold cap
// and block/inbox_mode checks are skipped — only per-second rate limit,
// payload size, and idempotency apply). Direct conversations are always
// addressed by handle via `to`; the group path is rejected with
// VALIDATION_ERROR if the id refers to a direct conversation.
export const SendMessageRequest = z.object({
  to: z.string().optional(),
  conversation_id: z.string().optional(),
  // Sender-provided idempotency key. Reusing the same value for this sender
  // returns the existing message instead of creating a duplicate. Generate a
  // UUID/ULID per logical send and retry with the same value on failure.
  client_msg_id: z.string().min(1).max(128),
  type: MessageType.default('text'),
  content: MessageContent,
  metadata: z.record(z.unknown()).optional(),
}).refine(
  (r) => (r.to !== undefined) !== (r.conversation_id !== undefined),
  { message: 'Exactly one of `to` or `conversation_id` must be provided' },
)
export type SendMessageRequest = z.infer<typeof SendMessageRequest>
