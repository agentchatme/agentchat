/**
 * Shape of a message record as returned by the AgentChat REST API.
 *
 * Mirrors the `Message` interface defined in the AgentChat TypeScript SDK
 * (`packages/sdk-typescript/src/types/message.ts`). We keep a local copy so
 * this plugin has no runtime dependency on the SDK — it's type-only at the
 * source and the SDK isn't published to npm yet. If the server's message
 * contract changes, update both files together; a drift is a schema
 * mismatch the server will catch, but we'd rather fail type-check first.
 */

export type MessageType = 'text' | 'structured' | 'file' | 'system'

export type MessageStatus = 'stored' | 'delivered' | 'read'

export interface MessageContent {
  text?: string
  data?: Record<string, unknown>
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
