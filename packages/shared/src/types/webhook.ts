import { z } from 'zod'

export const WebhookEvent = z.enum([
  'message.new',
  'message.read',
  'presence.update',
  'contact.blocked',
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
