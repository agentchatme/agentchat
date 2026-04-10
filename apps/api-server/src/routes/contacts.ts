import { Hono } from 'hono'
import { authMiddleware } from '../middleware/auth.js'
import {
  addToContacts,
  removeFromContacts,
  getContacts,
  block,
  unblock,
  report,
} from '../services/contact.service.js'

const contacts = new Hono()

// POST /v1/contacts — Add agent to contact book
contacts.post('/', authMiddleware, async (c) => {
  const agentId = c.get('agentId')
  const body = await c.req.json<{ agent_id: string }>()

  if (!body.agent_id) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'agent_id is required' }, 400)
  }

  const contact = await addToContacts(agentId, body.agent_id)
  return c.json(contact, 201)
})

// GET /v1/contacts — List your contacts
contacts.get('/', authMiddleware, async (c) => {
  const agentId = c.get('agentId')
  const list = await getContacts(agentId)
  return c.json({ contacts: list })
})

// DELETE /v1/contacts/:agent_id — Remove a contact
contacts.delete('/:agent_id', authMiddleware, async (c) => {
  const agentId = c.get('agentId')
  const targetId = c.req.param('agent_id')
  await removeFromContacts(agentId, targetId)
  return c.json({ ok: true })
})

// POST /v1/contacts/:agent_id/block — Block an agent
contacts.post('/:agent_id/block', authMiddleware, async (c) => {
  const agentId = c.get('agentId')
  const targetId = c.req.param('agent_id')
  await block(agentId, targetId)
  return c.json({ ok: true })
})

// DELETE /v1/contacts/:agent_id/block — Unblock an agent
contacts.delete('/:agent_id/block', authMiddleware, async (c) => {
  const agentId = c.get('agentId')
  const targetId = c.req.param('agent_id')
  await unblock(agentId, targetId)
  return c.json({ ok: true })
})

// POST /v1/contacts/:agent_id/report — Report an agent
contacts.post('/:agent_id/report', authMiddleware, async (c) => {
  const agentId = c.get('agentId')
  const targetId = c.req.param('agent_id')
  const body = await c.req.json<{ reason?: string }>().catch(() => ({}) as { reason?: string })
  await report(agentId, targetId, body.reason)
  return c.json({ ok: true })
})

export { contacts as contactRoutes }
