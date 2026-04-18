/**
 * AgentChat only supports hide-for-me deletion, which never changes the
 * recipient's view of a message — so there is intentionally no
 * `message.deleted` webhook event.
 */
export type WebhookEvent =
  | 'message.new'
  | 'message.read'
  | 'presence.update'
  | 'contact.blocked'
  | 'group.invite.received'
  | 'group.deleted'

export interface WebhookConfig {
  id: string
  url: string
  events: WebhookEvent[]
  active: boolean
  created_at: string
}

export interface CreateWebhookRequest {
  url: string
  events: WebhookEvent[]
}

export interface WebhookPayload {
  event: WebhookEvent
  timestamp: string
  data: Record<string, unknown>
}
