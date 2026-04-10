import { Hono } from 'hono'
import { CreateAgentRequest, UpdateAgentRequest } from '@agentchat/shared'
import { ownerAuthMiddleware } from '../middleware/owner-auth.js'
import { createAgent, getAgent, updateAgent, deleteAgent, listOwnerAgents, AgentError } from '../services/agent.service.js'

const agents = new Hono()

// POST /v1/agents — Create agent identity (owner auth)
agents.post('/', ownerAuthMiddleware, async (c) => {
  const body = await c.req.json()
  const parsed = CreateAgentRequest.safeParse(body)
  if (!parsed.success) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid request', details: parsed.error.flatten() }, 400)
  }

  try {
    const ownerId = c.get('ownerId')
    const agent = await createAgent(parsed.data, ownerId)
    return c.json(agent, 201)
  } catch (e) {
    if (e instanceof AgentError) {
      return c.json({ code: e.code, message: e.message }, e.status as 400 | 403 | 404 | 409)
    }
    throw e
  }
})

// GET /v1/agents — List owner's agents (owner auth)
agents.get('/', ownerAuthMiddleware, async (c) => {
  const ownerId = c.get('ownerId')
  const agentsList = await listOwnerAgents(ownerId)
  return c.json(agentsList)
})

// GET /v1/agents/:id — Get agent profile (public)
agents.get('/:id', async (c) => {
  const id = c.req.param('id')
  try {
    const agent = await getAgent(id)
    return c.json(agent)
  } catch (e) {
    if (e instanceof AgentError) {
      return c.json({ code: e.code, message: e.message }, e.status as 404)
    }
    throw e
  }
})

// PATCH /v1/agents/:id — Update profile (owner auth)
agents.patch('/:id', ownerAuthMiddleware, async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json()
  const parsed = UpdateAgentRequest.safeParse(body)
  if (!parsed.success) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid request', details: parsed.error.flatten() }, 400)
  }

  try {
    const ownerId = c.get('ownerId')
    const agent = await updateAgent(id, parsed.data, ownerId)
    return c.json(agent)
  } catch (e) {
    if (e instanceof AgentError) {
      return c.json({ code: e.code, message: e.message }, e.status as 400 | 403 | 404)
    }
    throw e
  }
})

// DELETE /v1/agents/:id — Delete agent (owner auth)
agents.delete('/:id', ownerAuthMiddleware, async (c) => {
  const id = c.req.param('id')
  try {
    const ownerId = c.get('ownerId')
    await deleteAgent(id, ownerId)
    return c.json({ message: 'Agent deleted' })
  } catch (e) {
    if (e instanceof AgentError) {
      return c.json({ code: e.code, message: e.message }, e.status as 403 | 404)
    }
    throw e
  }
})

export { agents as agentRoutes }
