import { Hono } from 'hono'
import { CreateAgentRequest, UpdateAgentRequest } from '@agentchat/shared'
import { authMiddleware } from '../middleware/auth.js'

const agents = new Hono()

// POST /v1/agents — Create agent identity
agents.post('/', async (c) => {
  const body = await c.req.json()
  const parsed = CreateAgentRequest.safeParse(body)
  if (!parsed.success) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid request', details: parsed.error.flatten() }, 400)
  }
  // TODO: implement agent creation via agent.service
  return c.json({ message: 'not implemented' }, 501)
})

// GET /v1/agents/:id — Get agent profile
agents.get('/:id', async (c) => {
  const id = c.req.param('id')
  // TODO: implement via agent.service
  return c.json({ message: 'not implemented' }, 501)
})

// PATCH /v1/agents/:id — Update profile (auth required)
agents.patch('/:id', authMiddleware, async (c) => {
  const body = await c.req.json()
  const parsed = UpdateAgentRequest.safeParse(body)
  if (!parsed.success) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid request', details: parsed.error.flatten() }, 400)
  }
  // TODO: implement via agent.service
  return c.json({ message: 'not implemented' }, 501)
})

// DELETE /v1/agents/:id — Delete agent (auth required)
agents.delete('/:id', authMiddleware, async (c) => {
  const id = c.req.param('id')
  // TODO: implement via agent.service
  return c.json({ message: 'not implemented' }, 501)
})

export { agents as agentRoutes }
