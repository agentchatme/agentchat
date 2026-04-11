import { Hono } from 'hono'
import { PresenceUpdate } from '@agentchat/shared'
import { authMiddleware } from '../middleware/auth.js'

const presence = new Hono()

// GET /v1/presence/:handle — Check if online
presence.get('/:handle', async (c) => {
  // TODO: implement via presence.service
  return c.json({ message: 'not implemented' }, 501)
})

// PUT /v1/presence — Update presence (auth required)
presence.put('/', authMiddleware, async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }, 400)
  }
  const parsed = PresenceUpdate.safeParse(body)
  if (!parsed.success) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid request', details: parsed.error.flatten() }, 400)
  }
  // TODO: implement via presence.service
  return c.json({ message: 'not implemented' }, 501)
})

export { presence as presenceRoutes }
