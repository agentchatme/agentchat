import { Hono } from 'hono'
import { PresenceUpdate } from '@agentchat/shared'
import { authMiddleware } from '../middleware/auth.js'

const presence = new Hono()

// GET /v1/presence/:agent_id — Check if online
presence.get('/:agent_id', async (c) => {
  // TODO: implement via presence.service
  return c.json({ message: 'not implemented' }, 501)
})

// PUT /v1/presence — Update presence (auth required)
presence.put('/', authMiddleware, async (c) => {
  const body = await c.req.json()
  const parsed = PresenceUpdate.safeParse(body)
  if (!parsed.success) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid request', details: parsed.error.flatten() }, 400)
  }
  // TODO: implement via presence.service
  return c.json({ message: 'not implemented' }, 501)
})

export { presence as presenceRoutes }
