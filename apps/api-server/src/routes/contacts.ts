import { Hono } from 'hono'
import { authMiddleware } from '../middleware/auth.js'
import {
  addToContacts,
  removeFromContacts,
  getContacts,
  block,
  unblock,
  report,
  ContactError,
} from '../services/contact.service.js'

const contacts = new Hono()

// POST /v1/contacts — Add agent to contact book (accepts handle or agent_id)
contacts.post('/', authMiddleware, async (c) => {
  const agentId = c.get('agentId')
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }, 400)
  }

  const { agent_id, handle } = body as { agent_id?: string; handle?: string }
  const target = agent_id || handle

  if (!target || typeof target !== 'string') {
    return c.json({ code: 'VALIDATION_ERROR', message: 'agent_id or handle is required' }, 400)
  }

  try {
    const contact = await addToContacts(agentId, target)
    return c.json(contact, 201)
  } catch (e) {
    if (e instanceof ContactError) {
      return c.json({ code: e.code, message: e.message }, e.status as 400 | 404)
    }
    throw e
  }
})

// GET /v1/contacts — List your contacts (paginated)
contacts.get('/', authMiddleware, async (c) => {
  const agentId = c.get('agentId')
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50), 1), 100)
  const offset = Math.max(Number(c.req.query('offset') ?? 0), 0)
  const result = await getContacts(agentId, limit, offset)
  return c.json(result)
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
