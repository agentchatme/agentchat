import { Hono } from 'hono'
import { SendMessageRequest } from '@agentchat/shared'
import { authMiddleware } from '../middleware/auth.js'
import {
  sendMessage,
  getMessages,
  markAsRead,
  syncUndelivered,
  removeMessage,
  MessageError,
} from '../services/message.service.js'

const messages = new Hono()

// POST /v1/messages — Send a message (agent auth)
messages.post('/', authMiddleware, async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }, 400)
  }
  const parsed = SendMessageRequest.safeParse(body)
  if (!parsed.success) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid request', details: parsed.error.flatten() }, 400)
  }

  try {
    const agentId = c.get('agentId')
    const message = await sendMessage(agentId, parsed.data)
    return c.json(message, 201)
  } catch (e) {
    if (e instanceof MessageError) {
      const headers: Record<string, string> = {}
      if (e.retryAfter) {
        headers['Retry-After'] = String(Math.ceil(e.retryAfter / 1000))
      }
      return c.json(
        { code: e.code, message: e.message },
        { status: e.status as 400 | 403 | 404 | 429, headers },
      )
    }
    throw e
  }
})

// GET /v1/messages/sync — Get undelivered messages for this agent (agent auth)
// This must be before /:conversation_id to avoid route conflict
messages.get('/sync', authMiddleware, async (c) => {
  const agentId = c.get('agentId')
  const undelivered = await syncUndelivered(agentId)
  return c.json(undelivered)
})

// GET /v1/messages/:conversation_id — Get conversation history (agent auth)
messages.get('/:conversation_id', authMiddleware, async (c) => {
  const conversationId = c.req.param('conversation_id')
  const limit = Number(c.req.query('limit') ?? 50)
  const before = c.req.query('before') ?? undefined

  try {
    const agentId = c.get('agentId')
    const msgs = await getMessages(agentId, conversationId, limit, before)
    return c.json(msgs)
  } catch (e) {
    if (e instanceof MessageError) {
      return c.json({ code: e.code, message: e.message }, e.status as 403)
    }
    throw e
  }
})

// POST /v1/messages/:id/read — Mark message as read (agent auth)
messages.post('/:id/read', authMiddleware, async (c) => {
  const messageId = c.req.param('id')
  const agentId = c.get('agentId')
  const message = await markAsRead(messageId, agentId)
  return c.json(message)
})

// DELETE /v1/messages/:id — Delete a message (agent auth, sender only)
messages.delete('/:id', authMiddleware, async (c) => {
  const messageId = c.req.param('id')
  const agentId = c.get('agentId')
  try {
    await removeMessage(messageId, agentId)
    return c.json({ message: 'Message deleted' })
  } catch (e) {
    if (e instanceof MessageError) {
      return c.json({ code: e.code, message: e.message }, e.status as 404)
    }
    throw e
  }
})

export { messages as messageRoutes }
