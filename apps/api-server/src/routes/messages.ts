import { Hono } from 'hono'
import { SendMessageRequest } from '@agentchat/shared'
import { authMiddleware } from '../middleware/auth.js'

const messages = new Hono()

// POST /v1/messages — Send a message (auth required)
messages.post('/', authMiddleware, async (c) => {
  const body = await c.req.json()
  const parsed = SendMessageRequest.safeParse(body)
  if (!parsed.success) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid request', details: parsed.error.flatten() }, 400)
  }
  // TODO: implement via message.service
  return c.json({ message: 'not implemented' }, 501)
})

// GET /v1/messages/:conversation_id — Get conversation history (auth required)
messages.get('/:conversation_id', authMiddleware, async (c) => {
  const conversationId = c.req.param('conversation_id')
  // TODO: implement via message.service
  return c.json({ message: 'not implemented' }, 501)
})

// DELETE /v1/messages/:id — Delete a message (auth required)
messages.delete('/:id', authMiddleware, async (c) => {
  const id = c.req.param('id')
  // TODO: implement via message.service
  return c.json({ message: 'not implemented' }, 501)
})

export { messages as messageRoutes }
