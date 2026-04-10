import { Hono } from 'hono'
import { CreateWebhookRequest } from '@agentchat/shared'
import { authMiddleware } from '../middleware/auth.js'

const webhooks = new Hono()

// POST /v1/webhooks — Register webhook (auth required)
webhooks.post('/', authMiddleware, async (c) => {
  const body = await c.req.json()
  const parsed = CreateWebhookRequest.safeParse(body)
  if (!parsed.success) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid request', details: parsed.error.flatten() }, 400)
  }
  // TODO: implement via webhook.service
  return c.json({ message: 'not implemented' }, 501)
})

export { webhooks as webhookRoutes }
