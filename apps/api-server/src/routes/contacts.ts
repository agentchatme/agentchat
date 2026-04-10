import { Hono } from 'hono'
import { authMiddleware } from '../middleware/auth.js'

const contacts = new Hono()

// GET /v1/contacts — List contacts (auth required)
contacts.get('/', authMiddleware, async (c) => {
  // TODO: implement
  return c.json({ message: 'not implemented' }, 501)
})

// POST /v1/contacts/:id/block — Block an agent (auth required)
contacts.post('/:id/block', authMiddleware, async (c) => {
  // TODO: implement via contact.service
  return c.json({ message: 'not implemented' }, 501)
})

// DELETE /v1/contacts/:id/block — Unblock an agent (auth required)
contacts.delete('/:id/block', authMiddleware, async (c) => {
  // TODO: implement via contact.service
  return c.json({ message: 'not implemented' }, 501)
})

// POST /v1/contacts/:id/report — Report an agent (auth required)
contacts.post('/:id/report', authMiddleware, async (c) => {
  // TODO: implement
  return c.json({ message: 'not implemented' }, 501)
})

export { contacts as contactRoutes }
