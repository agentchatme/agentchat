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

// POST /v1/contacts — Add agent to contact book (by handle)
contacts.post('/', authMiddleware, async (c) => {
  const agentId = c.get('agentId')
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }, 400)
  }

  const { handle } = body as { handle?: string }
  if (!handle || typeof handle !== 'string') {
    return c.json({ code: 'VALIDATION_ERROR', message: 'handle is required' }, 400)
  }

  try {
    const contact = await addToContacts(agentId, handle.replace(/^@/, '').toLowerCase())
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

// DELETE /v1/contacts/:handle — Remove a contact
contacts.delete('/:handle', authMiddleware, async (c) => {
  const agentId = c.get('agentId')
  const handle = c.req.param('handle').replace(/^@/, '').toLowerCase()
  try {
    await removeFromContacts(agentId, handle)
  } catch (e) {
    if (e instanceof ContactError) {
      return c.json({ code: e.code, message: e.message }, e.status as 404)
    }
    throw e
  }
  return c.json({ ok: true })
})

// POST /v1/contacts/:handle/block — Block an agent
contacts.post('/:handle/block', authMiddleware, async (c) => {
  const agentId = c.get('agentId')
  const handle = c.req.param('handle').replace(/^@/, '').toLowerCase()
  try {
    await block(agentId, handle)
  } catch (e) {
    if (e instanceof ContactError) {
      return c.json({ code: e.code, message: e.message }, e.status as 400 | 404)
    }
    throw e
  }
  return c.json({ ok: true })
})

// DELETE /v1/contacts/:handle/block — Unblock an agent
contacts.delete('/:handle/block', authMiddleware, async (c) => {
  const agentId = c.get('agentId')
  const handle = c.req.param('handle').replace(/^@/, '').toLowerCase()
  try {
    await unblock(agentId, handle)
  } catch (e) {
    if (e instanceof ContactError) {
      return c.json({ code: e.code, message: e.message }, e.status as 404)
    }
    throw e
  }
  return c.json({ ok: true })
})

// POST /v1/contacts/:handle/report — Report an agent
contacts.post('/:handle/report', authMiddleware, async (c) => {
  const agentId = c.get('agentId')
  const handle = c.req.param('handle').replace(/^@/, '').toLowerCase()
  const body = await c.req.json<{ reason?: string }>().catch(() => ({}) as { reason?: string })
  try {
    await report(agentId, handle, body.reason)
  } catch (e) {
    if (e instanceof ContactError) {
      return c.json({ code: e.code, message: e.message }, e.status as 400 | 404)
    }
    throw e
  }
  return c.json({ ok: true })
})

export { contacts as contactRoutes }
