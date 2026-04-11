import { Hono } from 'hono'
import { CreateWebhookRequest } from '@agentchat/shared'
import { authMiddleware } from '../middleware/auth.js'
import {
  registerWebhook,
  listWebhooks,
  getWebhook,
  removeWebhook,
} from '../services/webhook.service.js'

const webhooks = new Hono()

// POST /v1/webhooks — Register a webhook
webhooks.post('/', authMiddleware, async (c) => {
  const agentId = c.get('agentId')
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }, 400)
  }
  const parsed = CreateWebhookRequest.safeParse(body)
  if (!parsed.success) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid request', details: parsed.error.flatten() }, 400)
  }

  const webhook = await registerWebhook(agentId, parsed.data.url, parsed.data.events)
  return c.json(webhook, 201)
})

// GET /v1/webhooks — List your webhooks
webhooks.get('/', authMiddleware, async (c) => {
  const agentId = c.get('agentId')
  const list = await listWebhooks(agentId)
  return c.json({ webhooks: list })
})

// GET /v1/webhooks/:id — Get a specific webhook
webhooks.get('/:id', authMiddleware, async (c) => {
  const agentId = c.get('agentId')
  const id = c.req.param('id')
  const webhook = await getWebhook(id, agentId)
  return c.json(webhook)
})

// DELETE /v1/webhooks/:id — Delete a webhook
webhooks.delete('/:id', authMiddleware, async (c) => {
  const agentId = c.get('agentId')
  const id = c.req.param('id')
  await removeWebhook(id, agentId)
  return c.json({ ok: true })
})

export { webhooks as webhookRoutes }
