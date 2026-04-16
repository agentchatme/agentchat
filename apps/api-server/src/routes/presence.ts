import { Hono } from 'hono'
import { PresenceUpdate, PresenceBatchRequest } from '@agentchat/shared'
import { authMiddleware } from '../middleware/auth.js'
import { findAgentByHandle, isContact } from '@agentchat/db'
import {
  setPresence,
  getPresence,
  getPresenceBatch,
} from '../services/presence.service.js'

const presence = new Hono()

// ─── GET /v1/presence/:handle ─────────────────────────────────────────────
// Returns the presence state of a single agent. Contact-scoped: the caller
// must have the target as a contact to see their presence. Without this
// gate any agent could poll the online status of every other agent in the
// directory, which is a privacy leak.
//
// If the target doesn't exist or the caller hasn't added them as a contact,
// return 404 — same shape for both, so a curious agent can't enumerate
// handles via the presence endpoint.
presence.get('/:handle', authMiddleware, async (c) => {
  const callerAgentId = c.get('agentId')
  const targetHandle = c.req.param('handle')

  // Resolve handle → agent row
  const target = await findAgentByHandle(targetHandle)
  if (!target) {
    return c.json({ code: 'NOT_FOUND', message: 'Agent not found' }, 404)
  }

  // Contact-scoping: caller must have target as a contact
  const hasContact = await isContact(callerAgentId, target.id as string)
  if (!hasContact) {
    return c.json({ code: 'NOT_FOUND', message: 'Agent not found' }, 404)
  }

  const result = await getPresence(target.id as string, targetHandle)
  return c.json(result)
})

// ─── PUT /v1/presence ─────────────────────────────────────────────────────
// Set the caller's own presence status. Broadcasts the change to every
// agent who has the caller in their contact book.
presence.put('/', authMiddleware, async (c) => {
  const agent = c.get('agent')

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }, 400)
  }

  const parsed = PresenceUpdate.safeParse(body)
  if (!parsed.success) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: 'Invalid request', details: parsed.error.flatten() },
      400,
    )
  }

  await setPresence(
    agent.id as string,
    agent.handle as string,
    parsed.data.status,
    parsed.data.custom_message ?? null,
    true, // broadcast
  )

  return c.json({
    handle: agent.handle,
    status: parsed.data.status,
    custom_message: parsed.data.custom_message ?? null,
  })
})

// ─── POST /v1/presence/batch ──────────────────────────────────────────────
// Query presence for up to 100 handles at once. No contact-scoping on batch
// — the caller only sees handles they explicitly pass, and the batch is
// expected to be used with the caller's own contact list. Applying per-entry
// contact checks on 100 handles would be 100 DB queries which defeats the
// purpose. The single-handle GET endpoint enforces contact scope for fine-
// grained lookups.
presence.post('/batch', authMiddleware, async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }, 400)
  }

  const parsed = PresenceBatchRequest.safeParse(body)
  if (!parsed.success) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: 'Invalid request', details: parsed.error.flatten() },
      400,
    )
  }

  const results = await getPresenceBatch(parsed.data.handles)
  return c.json({ presences: results })
})

export { presence as presenceRoutes }
