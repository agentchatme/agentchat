export type MessageType = 'text' | 'structured' | 'file' | 'system'

export type MessageStatus = 'stored' | 'delivered' | 'read'

/**
 * Payload body. At least one of `text`, `data`, or `attachment_id` must be
 * set — the server rejects empty content with VALIDATION_ERROR.
 */
export interface MessageContent {
  text?: string
  data?: Record<string, unknown>
  /**
   * Attachment id returned by `POST /v1/uploads`. The recipient fetches the
   * underlying bytes via `GET /v1/attachments/:id`.
   */
  attachment_id?: string
}

export interface Message {
  id: string
  conversation_id: string
  sender: string
  client_msg_id: string
  seq: number
  type: MessageType
  content: MessageContent
  metadata: Record<string, unknown>
  status: MessageStatus
  created_at: string
  delivered_at: string | null
  read_at: string | null
}

/**
 * Exactly one of `to` or `conversation_id` must be set:
 * - `to` is the direct-send path (handle resolution, cold-cap + block +
 *   inbox_mode gating, auto-create direct conversation).
 * - `conversation_id` is the group-send path (membership is the consent,
 *   so cold cap and block/inbox_mode checks are skipped).
 *
 * `client_msg_id` is required and is the sender-provided idempotency key —
 * reusing the same value returns the existing message instead of creating
 * a duplicate. Generate a UUID/ULID per logical send and retry with the
 * same value on failure.
 */
export interface SendMessageRequest {
  to?: string
  conversation_id?: string
  client_msg_id: string
  type?: MessageType
  content: MessageContent
  metadata?: Record<string, unknown>
}
