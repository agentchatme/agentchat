import { Hono, type Context } from 'hono'
import { authMiddleware } from '../middleware/auth.js'
import { findAgentByHandle } from '@agentchat/db'
import {
  createMuteForAgent,
  removeMuteForAgent,
  listMutesForAgent,
  getMuteForAgent,
  MuteError,
} from '../services/mute.service.js'
import { checkMuteWriteRateLimit } from '../services/enforcement.service.js'

const mutes = new Hono()

// Apply the mute-write rate limit. 429 with Retry-After ms so clients can
// back off mechanically. Fails open on Redis outage (see enforcement
// service for rationale). Called from POST + DELETE paths; GETs are on
// the global per-request budget at the edge and don't need their own
// bucket.
async function guardMuteWriteRate(c: Context, muterAgentId: string) {
  const check = await checkMuteWriteRateLimit(muterAgentId)
  if (check.allowed) return null
  return c.json(
    {
      code: 'RATE_LIMITED',
      message: 'Too many mute writes per second',
      retry_after_ms: check.retryAfterMs,
    },
    429,
  )
}

type MuteErrorStatus = 400 | 403 | 404

function respondMuteError(c: Context, e: MuteError) {
  return c.json({ code: e.code, message: e.message }, e.status as MuteErrorStatus)
}

// Translate (kind, pathValue) → target agent/conversation id that the
// service layer understands. Keeps handle→id lookup a route concern so the
// service can stay purely id-based and easier to unit-test. Throws a
// MuteError on invalid kind or unknown handle; the caller's try/catch
// handles it uniformly.
async function resolveTarget(kind: string, pathValue: string): Promise<string> {
  if (kind === 'agent') {
    const handle = pathValue.replace(/^@/, '').toLowerCase()
    const agent = await findAgentByHandle(handle)
    if (!agent) {
      throw new MuteError('AGENT_NOT_FOUND', `Account @${handle} not found`, 404)
    }
    return agent.id
  }
  if (kind === 'conversation') {
    return pathValue
  }
  throw new MuteError(
    'VALIDATION_ERROR',
    `target_kind must be 'agent' or 'conversation', got '${kind}'`,
    400,
  )
}

// POST /v1/mutes — Mute an agent (1-on-1) or a conversation.
//
// Body: { target_kind: 'agent' | 'conversation', target_handle?: string,
//         target_id?: string, muted_until?: string | null }
//
// For target_kind='agent' pass `target_handle` (preferred) — internal
// agent ids are not part of the public surface. `target_id` is accepted
// as a fallback for integrations that already carry the id.
// For target_kind='conversation' pass `target_id` (the conversation id).
//
// Idempotent by natural key (muter, kind, target_id) — the service upserts,
// so a retry with a fresh muted_until refreshes the expiry rather than
// erroring. That means we don't need Idempotency-Key middleware here:
// duplicate POSTs converge to the same row, unlike block/report which have
// side effects (enforcement eval, webhooks) beyond the row write.
mutes.post('/', authMiddleware, async (c) => {
  const muterAgentId = c.get('agentId')

  const rateLimited = await guardMuteWriteRate(c, muterAgentId)
  if (rateLimited) return rateLimited

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }, 400)
  }

  const { target_kind, target_handle, target_id, muted_until } = (body ?? {}) as {
    target_kind?: unknown
    target_handle?: unknown
    target_id?: unknown
    muted_until?: unknown
  }

  if (typeof target_kind !== 'string') {
    return c.json({ code: 'VALIDATION_ERROR', message: 'target_kind is required' }, 400)
  }
  if (
    muted_until !== undefined &&
    muted_until !== null &&
    typeof muted_until !== 'string'
  ) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: 'muted_until must be an ISO-8601 string or null' },
      400,
    )
  }

  // Resolve the target id once. kind=agent accepts handle OR id;
  // kind=conversation requires id.
  let resolvedTargetId: string
  try {
    if (target_kind === 'agent') {
      if (typeof target_handle === 'string' && target_handle.length > 0) {
        resolvedTargetId = await resolveTarget('agent', target_handle)
      } else if (typeof target_id === 'string' && target_id.length > 0) {
        resolvedTargetId = target_id
      } else {
        return c.json(
          { code: 'VALIDATION_ERROR', message: 'target_handle or target_id is required for agent mutes' },
          400,
        )
      }
    } else if (target_kind === 'conversation') {
      if (typeof target_id !== 'string' || target_id.length === 0) {
        return c.json(
          { code: 'VALIDATION_ERROR', message: 'target_id is required for conversation mutes' },
          400,
        )
      }
      resolvedTargetId = target_id
    } else {
      return c.json(
        { code: 'VALIDATION_ERROR', message: `target_kind must be 'agent' or 'conversation', got '${target_kind}'` },
        400,
      )
    }
  } catch (e) {
    if (e instanceof MuteError) return respondMuteError(c, e)
    throw e
  }

  try {
    const row = await createMuteForAgent({
      muterAgentId,
      targetKind: target_kind,
      targetId: resolvedTargetId,
      mutedUntil: (muted_until as string | null | undefined) ?? null,
    })
    return c.json(row, 201)
  } catch (e) {
    if (e instanceof MuteError) return respondMuteError(c, e)
    throw e
  }
})

// GET /v1/mutes — List the caller's active mutes.
//
// Query: ?kind=agent|conversation (optional filter).
// Expired mutes are filtered at the DB layer so the list only contains
// rows still in effect.
mutes.get('/', authMiddleware, async (c) => {
  const muterAgentId = c.get('agentId')
  const kind = c.req.query('kind')

  try {
    const rows = await listMutesForAgent(muterAgentId, kind ? { kind } : {})
    return c.json({ mutes: rows })
  } catch (e) {
    if (e instanceof MuteError) return respondMuteError(c, e)
    throw e
  }
})

// GET /v1/mutes/agent/:handle — Mute status for a single agent.
// Returns the mute row if active, or 404 if not muted / expired.
mutes.get('/agent/:handle', authMiddleware, async (c) => {
  const muterAgentId = c.get('agentId')
  const handle = c.req.param('handle')

  try {
    const targetId = await resolveTarget('agent', handle)
    const row = await getMuteForAgent(muterAgentId, 'agent', targetId)
    if (!row) {
      return c.json({ code: 'NOT_FOUND', message: 'No active mute for that agent' }, 404)
    }
    return c.json(row)
  } catch (e) {
    if (e instanceof MuteError) return respondMuteError(c, e)
    throw e
  }
})

// GET /v1/mutes/conversation/:id — Mute status for a single conversation.
mutes.get('/conversation/:id', authMiddleware, async (c) => {
  const muterAgentId = c.get('agentId')
  const id = c.req.param('id')

  try {
    const row = await getMuteForAgent(muterAgentId, 'conversation', id)
    if (!row) {
      return c.json({ code: 'NOT_FOUND', message: 'No active mute for that conversation' }, 404)
    }
    return c.json(row)
  } catch (e) {
    if (e instanceof MuteError) return respondMuteError(c, e)
    throw e
  }
})

// DELETE /v1/mutes/agent/:handle — Unmute an agent.
//
// Returns 404 if no active mute existed. That's intentional: a flaky client
// that double-unmutes shouldn't get a silent 200 both times — the second
// call tells them the first already landed.
mutes.delete('/agent/:handle', authMiddleware, async (c) => {
  const muterAgentId = c.get('agentId')
  const handle = c.req.param('handle')

  const rateLimited = await guardMuteWriteRate(c, muterAgentId)
  if (rateLimited) return rateLimited

  try {
    const targetId = await resolveTarget('agent', handle)
    await removeMuteForAgent({ muterAgentId, targetKind: 'agent', targetId })
  } catch (e) {
    if (e instanceof MuteError) return respondMuteError(c, e)
    throw e
  }
  return c.json({ ok: true })
})

// DELETE /v1/mutes/conversation/:id — Unmute a conversation.
mutes.delete('/conversation/:id', authMiddleware, async (c) => {
  const muterAgentId = c.get('agentId')
  const id = c.req.param('id')

  const rateLimited = await guardMuteWriteRate(c, muterAgentId)
  if (rateLimited) return rateLimited

  try {
    await removeMuteForAgent({ muterAgentId, targetKind: 'conversation', targetId: id })
  } catch (e) {
    if (e instanceof MuteError) return respondMuteError(c, e)
    throw e
  }
  return c.json({ ok: true })
})

export { mutes as muteRoutes }
