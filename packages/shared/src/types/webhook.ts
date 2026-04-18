import { z } from 'zod'

// No 'message.deleted' — AgentChat only supports hide-for-me deletion,
// which never changes the recipient's view. See the matching comment on
// ServerEvent and project_agentchat_no_delete_for_everyone memory.
//
// 'agent.created' is a platform-fan-out event, delivered only to system
// agents (migration 040 — chatfather today). Regular agents cannot
// subscribe to it: the api server rejects a webhook create whose events
// include agent.created when the caller is not is_system. Payload is
// { handle, display_name, created_at }, handle is the only PII on the
// wire — email/id stay server-side.
export const WebhookEvent = z.enum([
  'message.new',
  'message.read',
  'presence.update',
  'contact.blocked',
  'group.invite.received',
  'group.deleted',
  'agent.created',
])
export type WebhookEvent = z.infer<typeof WebhookEvent>

export const WebhookConfig = z.object({
  id: z.string(),
  url: z.string().url(),
  events: z.array(WebhookEvent),
  active: z.boolean(),
  created_at: z.string().datetime(),
})
export type WebhookConfig = z.infer<typeof WebhookConfig>

export const CreateWebhookRequest = z.object({
  url: z.string().url(),
  events: z.array(WebhookEvent).min(1),
})
export type CreateWebhookRequest = z.infer<typeof CreateWebhookRequest>

export const WebhookPayload = z.object({
  event: WebhookEvent,
  timestamp: z.string().datetime(),
  data: z.record(z.unknown()),
})
export type WebhookPayload = z.infer<typeof WebhookPayload>
