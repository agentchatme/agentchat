import { Hono } from 'hono'
import { SendMessageRequest } from '@agentchat/shared'
import { authMiddleware } from '../middleware/auth.js'
import {
  sendMessage,
  getMessages,
  markAsRead,
  syncUndelivered,
  ackDelivered,
  hideMessageForMe,
  deleteMessageForEveryone,
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
    const { message, isReplay } = await sendMessage(agentId, parsed.data)
    // 200 on idempotent replay (no new side effects), 201 on first write.
    return c.json(message, isReplay ? 200 : 201)
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

// GET /v1/messages/sync — Get undelivered messages for this agent (agent auth).
//
// Query params (both optional):
//   after  — opaque delivery_id cursor; only rows strictly after this are
//            returned. Pass back the delivery_id of the last row from the
//            previous response to page forward without committing anything.
//   limit  — max rows to return (default 200, max 500)
//
// This endpoint is non-destructive: it does NOT mark anything delivered.
// Call POST /v1/messages/sync/ack once the batch is safely processed.
//
// This must be before /:conversation_id to avoid route conflict.
messages.get('/sync', authMiddleware, async (c) => {
  const agentId = c.get('agentId')
  const after = c.req.query('after')
  const limitRaw = c.req.query('limit')
  const limit = limitRaw !== undefined && limitRaw !== '' ? Number(limitRaw) : undefined
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: 'limit must be a positive integer' },
      400,
    )
  }
  const undelivered = await syncUndelivered(agentId, { after, limit })
  return c.json(undelivered)
})

// POST /v1/messages/sync/ack — Commit a synced batch (agent auth).
//
// Body: { last_delivery_id: string }
//
// Marks every 'stored' delivery envelope for this agent at-or-before the
// given cursor as 'delivered'. Partial failures during client processing
// are safe: the client simply doesn't call ack until it's done, and the
// next /sync call returns the same unacked rows.
//
// Routed under /sync/ack (not /:id/sync-ack) so it's unambiguous with the
// /:conversation_id history route.
messages.post('/sync/ack', authMiddleware, async (c) => {
  const agentId = c.get('agentId')
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }, 400)
  }
  const lastDeliveryId = (body as { last_delivery_id?: unknown })?.last_delivery_id
  if (typeof lastDeliveryId !== 'string' || !lastDeliveryId) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: 'last_delivery_id is required' },
      400,
    )
  }

  const acked = await ackDelivered(agentId, lastDeliveryId)
  return c.json({ acked })
})

// GET /v1/messages/:conversation_id — Get conversation history (agent auth)
messages.get('/:conversation_id', authMiddleware, async (c) => {
  const conversationId = c.req.param('conversation_id')
  const limitRaw = Number(c.req.query('limit') ?? 50)
  const limit = Math.min(Math.max(limitRaw, 1), 200)
  const beforeSeqRaw = c.req.query('before_seq')
  const beforeSeq =
    beforeSeqRaw !== undefined && beforeSeqRaw !== '' ? Number(beforeSeqRaw) : undefined

  if (beforeSeq !== undefined && (!Number.isInteger(beforeSeq) || beforeSeq < 0)) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: 'before_seq must be a non-negative integer' },
      400,
    )
  }

  try {
    const agentId = c.get('agentId')
    const msgs = await getMessages(agentId, conversationId, limit, beforeSeq)
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

// DELETE /v1/messages/:id — Delete a message (agent auth)
//
// Query params:
//   scope=me        — hide from the caller's own view only (default).
//                     Any participant (sender or recipient) can call this.
//                     The other participant's view is unaffected.
//   scope=everyone  — tombstone for everyone in the conversation.
//                     Sender-only, and only within the 48h window after
//                     the message was sent. After 48h, this returns 403.
//                     Recipients receive a `message.deleted` WS + webhook
//                     event and should replace their local copy with a
//                     tombstone placeholder.
messages.delete('/:id', authMiddleware, async (c) => {
  const messageId = c.req.param('id')
  const agentId = c.get('agentId')
  const scopeRaw = c.req.query('scope') ?? 'me'
  if (scopeRaw !== 'me' && scopeRaw !== 'everyone') {
    return c.json(
      { code: 'VALIDATION_ERROR', message: 'scope must be "me" or "everyone"' },
      400,
    )
  }

  try {
    if (scopeRaw === 'everyone') {
      await deleteMessageForEveryone(messageId, agentId)
      return c.json({ message: 'Message deleted for everyone', scope: 'everyone' })
    } else {
      await hideMessageForMe(messageId, agentId)
      return c.json({ message: 'Message hidden from your view', scope: 'me' })
    }
  } catch (e) {
    if (e instanceof MessageError) {
      return c.json({ code: e.code, message: e.message }, e.status as 403 | 404 | 500)
    }
    throw e
  }
})

export { messages as messageRoutes }
