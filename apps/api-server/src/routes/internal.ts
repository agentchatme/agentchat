import { Hono } from 'hono'
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import {
  findAgentByHandle,
  rotateApiKeyAtomic,
  listSupportEscalations,
  updateSupportEscalationStatus,
  type SupportEscalationStatus,
} from '@agentchat/db'
import { generateId } from '../lib/id.js'
import { getRedis } from '../lib/redis.js'
import { env } from '../env.js'
import { publishDisconnect } from '../ws/pubsub.js'

const internal = new Hono()

// ─── Bearer auth (constant-time compare) ───────────────────────────────────
//
// Why a dedicated middleware here rather than reusing the metrics bearer
// guard: the metrics token is a low-privilege scraper credential (read-only
// Prometheus text output). The ops admin token is a rotate-keys-and-reset-
// the-system-account credential. Giving them the same path opens a foot-gun
// where an operator copies a Grafana env var into a rotation script and gets
// platform-admin by accident. Separate tokens, separate middleware, separate
// audit trails.
//
// Fail-closed when OPS_ADMIN_TOKEN is unset: 503 is more accurate than 401
// because the correct action is "set the env var" (operator misconfig),
// not "send credentials" (caller mistake).
async function requireOpsToken(c: import('hono').Context): Promise<Response | null> {
  const expected = env.OPS_ADMIN_TOKEN
  if (!expected) {
    return c.json(
      {
        code: 'OPS_AUTH_REQUIRED',
        message: 'Ops admin endpoints are disabled (OPS_ADMIN_TOKEN unset)',
      },
      503,
    )
  }

  const header = c.req.header('Authorization') ?? ''
  if (!header.startsWith('Bearer ')) {
    return c.json({ code: 'OPS_AUTH_REQUIRED', message: 'Missing Bearer credential' }, 401)
  }

  const provided = header.slice(7)
  // Reject early on length mismatch so timingSafeEqual doesn't throw on
  // differing-length inputs. The length check itself leaks the length of
  // the expected token, but the expected token is static per deploy and
  // attacker-known-length doesn't help if the bytes are opaque.
  if (provided.length !== expected.length) {
    return c.json({ code: 'OPS_AUTH_REQUIRED', message: 'Invalid credential' }, 401)
  }
  const ok = timingSafeEqual(
    Buffer.from(provided, 'utf8'),
    Buffer.from(expected, 'utf8'),
  )
  if (!ok) {
    return c.json({ code: 'OPS_AUTH_REQUIRED', message: 'Invalid credential' }, 401)
  }
  return null
}

// ─── Rate limit (Redis, 10 rotations / hour, fleet-wide) ───────────────────
//
// The ops admin token rotating its own target repeatedly is almost always a
// bug (script loop, misconfigured cron) — legitimate rotations happen at
// most a handful of times per week. 10/hour is low enough to contain a
// runaway script before it orphans a dozen stale keys and high enough that
// "I ran the rotation twice to be sure" never hits the limit.
//
// Fleet-wide (not per-machine) — rotations mutate DB state that every
// machine sees, so the counter must be shared. Redis is the obvious place.
// Fails CLOSED here unlike message-send: a Redis blip during a key rotation
// can wait; dropping the limit would let a broken script keep hammering.
async function rotationRateLimit(): Promise<{ allowed: boolean; current: number }> {
  const redis = getRedis()
  const hour = Math.floor(Date.now() / 3600_000)
  const key = `ops:rotate:${hour}`
  const current = await redis.incr(key)
  if (current === 1) {
    await redis.expire(key, 3600 + 60)
  }
  return { allowed: current <= 10, current }
}

// ─── POST /internal/rotate-system-agent-key ────────────────────────────────
//
// Mints a new API key for a system agent (migration 040 — chatfather today)
// and returns it exactly once. The public rotate-key path cannot rotate a
// system agent (agent.service.ts:rotateApiKey short-circuits on is_system),
// so this endpoint is the ONLY way to produce a working credential for
// chatfather after initial seed.
//
// First-run flow:
//   1. Operator sets OPS_ADMIN_TOKEN in Fly secrets.
//   2. Operator POSTs to this endpoint with { handle: "chatfather" }.
//   3. Operator stores the returned api_key in the chatfather-worker's
//      AGENTCHAT_API_KEY Fly secret.
//   4. chatfather worker boots and can now authenticate against the api.
//
// Rotation flow (quarterly or on suspected compromise):
//   1. Operator POSTs to this endpoint.
//   2. New api_key travels to chatfather worker via Fly secrets update.
//   3. Worker restarts and reconnects with the new key. Live WS sessions on
//      the old key are evicted via publishDisconnect (same 1008 code that
//      the public rotation path uses).
//
// Request body:
//   { handle: string }    // target system-agent handle, e.g. "chatfather"
//
// Response (200):
//   { handle: string, api_key: string }
//
// Response (404): target handle does not exist OR is not a system agent.
//   The response collapses the two cases into one "NOT_A_SYSTEM_AGENT" code
//   so the endpoint doesn't leak whether an arbitrary handle is a system
//   agent. Only operators who know the correct handle can distinguish.
internal.post('/rotate-system-agent-key', async (c) => {
  const authFail = await requireOpsToken(c)
  if (authFail) return authFail

  const rate = await rotationRateLimit()
  if (!rate.allowed) {
    c.header('Retry-After', '3600')
    return c.json(
      {
        code: 'RATE_LIMITED',
        message: 'Too many rotations in the last hour (max 10)',
      },
      429,
    )
  }

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }, 400)
  }
  const handle = (body as { handle?: unknown })?.handle
  if (typeof handle !== 'string' || handle.length === 0) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: '`handle` is required' },
      400,
    )
  }

  const normalized = handle.replace(/^@/, '').toLowerCase()
  const agent = await findAgentByHandle(normalized)
  if (!agent || agent.is_system !== true) {
    return c.json(
      {
        code: 'NOT_A_SYSTEM_AGENT',
        message: 'No system agent with that handle',
      },
      404,
    )
  }

  const newApiKey = `ac_${randomBytes(32).toString('base64url')}`
  const newHash = createHash('sha256').update(newApiKey).digest('hex')

  await rotateApiKeyAtomic({
    agent_id: agent.id,
    new_hash: newHash,
    rotated_event_id: generateId('evt'),
    revoked_event_id: generateId('evt'),
  })

  // Evict any live WS sessions opened with the old key. The worker will
  // reconnect on next deploy / restart with the new credential in its env.
  publishDisconnect(agent.id, 1008, 'System agent key rotated')

  return c.json({ handle: agent.handle, api_key: newApiKey })
})

// ─── GET /internal/support-escalations ─────────────────────────────────────
//
// Ops drain path for rows chatfather writes via
// apps/chatfather/src/escalation.ts (migration 041 schema). Default
// behavior returns the live working set (open + in_progress), newest
// first — ops triages from the top of this list.
//
// Query params:
//   ?status=open|in_progress|resolved|discarded|all   (default: live)
//   ?limit=N                                          (default: 50, max 200)
//   ?before=<ISO timestamp>                           (cursor for pagination)
//
// Response: { escalations: SupportEscalationRow[] }
//
// No Prometheus counter, no dashboard hookup — a handful per day is
// easier to read as JSON than to instrument. If the rate ever climbs
// we'll promote this to a proper dashboard.
internal.get('/support-escalations', async (c) => {
  const authFail = await requireOpsToken(c)
  if (authFail) return authFail

  const rawStatus = c.req.query('status')
  const rawLimit = c.req.query('limit')
  const before = c.req.query('before')

  const validStatuses = new Set<SupportEscalationStatus | 'live' | 'all'>([
    'open',
    'in_progress',
    'resolved',
    'discarded',
    'live',
    'all',
  ])
  const statusParam =
    rawStatus && validStatuses.has(rawStatus as SupportEscalationStatus | 'live' | 'all')
      ? (rawStatus as SupportEscalationStatus | 'live' | 'all')
      : 'live'

  const parsedLimit = rawLimit ? Number(rawLimit) : 50
  if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: '`limit` must be a positive number' },
      400,
    )
  }
  // Clamp to 200 so an operator who types ?limit=100000 by accident
  // doesn't drag back the entire history on one request.
  const limit = Math.min(parsedLimit, 200)

  const rows = await listSupportEscalations({
    status: statusParam === 'all' ? undefined : (statusParam as SupportEscalationStatus | 'live'),
    limit,
    beforeCreatedAt: before,
  })

  return c.json({ escalations: rows })
})

// ─── PATCH /internal/support-escalations/:id ───────────────────────────────
//
// Ops-side status transition. Body:
//   { status: 'open'|'in_progress'|'resolved'|'discarded',
//     resolution_note?: string }
//
// `resolved_by` is lifted from the operator's identity. We don't have a
// per-operator sign-in at this layer (the ops token is a shared
// credential), so we accept an `X-Ops-Operator` header and require a
// non-empty value — this is advisory-only and serves as a breadcrumb
// in the audit trail rather than a strict auth principal.
internal.patch('/support-escalations/:id', async (c) => {
  const authFail = await requireOpsToken(c)
  if (authFail) return authFail

  const id = c.req.param('id')
  if (!id) {
    return c.json({ code: 'VALIDATION_ERROR', message: '`id` is required' }, 400)
  }

  const operator = c.req.header('X-Ops-Operator')?.trim()
  if (!operator) {
    return c.json(
      {
        code: 'VALIDATION_ERROR',
        message: 'X-Ops-Operator header is required (your name/handle for the audit trail)',
      },
      400,
    )
  }

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }, 400)
  }

  const status = (body as { status?: unknown })?.status
  const resolutionNote = (body as { resolution_note?: unknown })?.resolution_note

  const allowedStatuses: ReadonlySet<SupportEscalationStatus> = new Set<SupportEscalationStatus>([
    'open',
    'in_progress',
    'resolved',
    'discarded',
  ])
  if (typeof status !== 'string' || !allowedStatuses.has(status as SupportEscalationStatus)) {
    return c.json(
      {
        code: 'VALIDATION_ERROR',
        message: '`status` must be one of open, in_progress, resolved, discarded',
      },
      400,
    )
  }
  if (resolutionNote !== undefined && typeof resolutionNote !== 'string') {
    return c.json(
      { code: 'VALIDATION_ERROR', message: '`resolution_note` must be a string' },
      400,
    )
  }

  const updated = await updateSupportEscalationStatus({
    id,
    status: status as SupportEscalationStatus,
    resolvedBy: operator,
    resolutionNote: resolutionNote as string | undefined,
  })

  if (!updated) {
    return c.json({ code: 'NOT_FOUND', message: 'No escalation with that id' }, 404)
  }

  return c.json({ escalation: updated })
})

export { internal as internalRoutes }
