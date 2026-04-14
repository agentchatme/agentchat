import { Hono } from 'hono'
import { setCookie, deleteCookie } from 'hono/cookie'
import {
  DashboardOtpRequest,
  DashboardOtpVerify,
  ClaimAgentRequest,
  PauseRequest,
} from '@agentchat/shared'
import {
  getSupabaseClient,
  findActiveAgentByEmail,
  findActiveOwnerByEmail,
  findOwnerById,
  insertOwner,
} from '@agentchat/db'
import { dashboardAuthMiddleware, DASHBOARD_SESSION_COOKIE } from '../middleware/dashboard-auth.js'
import { ipRateLimit } from '../middleware/rate-limit.js'
import {
  claimOtpSendSlot,
  releaseOtpSendSlot,
  registerOtpVerifyAttempt,
  clearOtpAttempts,
  OtpRateError,
} from '../services/otp.service.js'
import {
  claimAgent,
  releaseClaim,
  listAgentsForOwner,
  getAgentProfile,
  getAgentConversationsForOwner,
  getAgentMessagesForOwner,
  getAgentEventsForOwner,
  pauseAgent,
  unpauseAgent,
  DashboardError,
} from '../services/dashboard.service.js'
import { getRedis } from '../lib/redis.js'
import { emitEvent } from '../services/events.service.js'

const dashboard = new Hono()

// ─── Auth: OTP flow ────────────────────────────────────────────────────────
// Same Supabase email template as the agent flows (per §11.9 decision).
// Flow mirrors register/recover: request stores pending {email} in Redis,
// verify consumes it and sets an httpOnly session cookie. Pending TTL 10min.

interface PendingDashboardOtp {
  email: string
}

const PENDING_TTL = 600

// POST /dashboard/auth/otp/request — Send OTP to email (no auth)
dashboard.post('/auth/otp/request', ipRateLimit(5, 3600), async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }, 400)
  }
  const parsed = DashboardOtpRequest.safeParse(body)
  if (!parsed.success) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: 'Invalid request', details: parsed.error.flatten() },
      400,
    )
  }

  const email = parsed.data.email.toLowerCase().trim()

  // Email-namespace isolation — app-layer guard. If this email already
  // belongs to an active agent, surface a clean 409 rather than letting
  // the DB trigger raise a vague unique-violation downstream. The
  // partial unique index + trigger still backstop any race.
  const activeAgent = await findActiveAgentByEmail(email)
  if (activeAgent) {
    return c.json(
      {
        code: 'EMAIL_IS_AGENT',
        message:
          'This email is registered as an agent. Use a different email for the dashboard.',
      },
      409,
    )
  }

  // Per-email OTP rate limit — same cooldown/cap as agent flows. Swallowed
  // for unregistered owners? No — unlike /recover, the dashboard OTP does
  // NOT need to hide whether the email is already registered, because an
  // owner emailing themselves is a valid flow (login vs signup). We surface
  // the 429 directly.
  try {
    await claimOtpSendSlot(email)
  } catch (e) {
    if (e instanceof OtpRateError) {
      if (e.retryAfterSeconds) c.header('Retry-After', String(e.retryAfterSeconds))
      return c.json({ code: e.code, message: e.message }, 429)
    }
    throw e
  }

  // Use crypto.randomUUID via a dedicated prefix? No — we already have
  // generateId('pnd') for pending keys across all flows. Keeps Redis key
  // space consistent with register/recover/rotate.
  const pendingId = `dpnd_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
  const pending: PendingDashboardOtp = { email }

  const redis = getRedis()
  await redis.set(`dashboard:${pendingId}`, JSON.stringify(pending), { ex: PENDING_TTL })

  const supabase = getSupabaseClient()
  const { error } = await supabase.auth.signInWithOtp({ email })

  if (error) {
    console.error('[dashboard] signInWithOtp failed:', error.message, error.code, error.status)
    await redis.del(`dashboard:${pendingId}`).catch(() => {})
    await releaseOtpSendSlot(email)
    return c.json({ code: 'OTP_FAILED', message: 'Failed to send verification code' }, 500)
  }

  return c.json({ pending_id: pendingId, message: 'Verification code sent to email' })
})

// POST /dashboard/auth/otp/verify — Verify OTP, create/load owner, set cookie
dashboard.post('/auth/otp/verify', ipRateLimit(10, 600), async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }, 400)
  }
  const parsed = DashboardOtpVerify.safeParse(body)
  if (!parsed.success) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: 'Invalid request', details: parsed.error.flatten() },
      400,
    )
  }

  const { pending_id, code } = parsed.data
  const redis = getRedis()
  const raw = await redis.get<string>(`dashboard:${pending_id}`)

  if (!raw) {
    return c.json({ code: 'EXPIRED', message: 'Request expired. Please start again.' }, 400)
  }

  const pending: PendingDashboardOtp = typeof raw === 'string' ? JSON.parse(raw) : raw

  // Attempt cap — burn the pending on overflow so an attacker can't keep
  // probing the 6-digit code space.
  try {
    await registerOtpVerifyAttempt(pending_id, 'dashboard:')
  } catch (e) {
    if (e instanceof OtpRateError) {
      if (e.retryAfterSeconds) c.header('Retry-After', String(e.retryAfterSeconds))
      return c.json({ code: e.code, message: e.message }, 429)
    }
    throw e
  }

  const supabase = getSupabaseClient()
  const { data: verifyData, error: verifyError } = await supabase.auth.verifyOtp({
    email: pending.email,
    token: code,
    type: 'email',
  })

  if (verifyError || !verifyData.session || !verifyData.user) {
    return c.json({ code: 'INVALID_CODE', message: 'Invalid or expired verification code' }, 400)
  }

  // Burn the pending immediately.
  await redis.del(`dashboard:${pending_id}`)
  await clearOtpAttempts(pending_id)

  // Find-or-create owner. The owners.id mirrors auth.users.id so the JWT
  // maps directly. First login for this email creates the row; subsequent
  // logins just read it. The DB trigger still enforces namespace isolation
  // as a backstop — if the email is somehow an agent now (race after the
  // app-layer check), we surface EMAIL_IS_AGENT.
  const userId = verifyData.user.id
  const userEmail = verifyData.user.email ?? pending.email

  let owner = await findOwnerById(userId)
  if (!owner) {
    try {
      owner = await insertOwner({ id: userId, email: userEmail })
      await emitEvent({
        actorType: 'owner',
        actorId: userId,
        action: 'owner.created',
        targetId: userId,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      if (msg.includes('EMAIL_IS_AGENT')) {
        return c.json(
          {
            code: 'EMAIL_IS_AGENT',
            message:
              'This email is registered as an agent. Use a different email for the dashboard.',
          },
          409,
        )
      }
      // Race: another request just created the row. Re-fetch and continue.
      if (msg.includes('duplicate') || msg.includes('unique')) {
        owner = await findOwnerById(userId)
      } else {
        throw e
      }
    }
  }

  if (!owner) {
    return c.json({ code: 'OWNER_NOT_FOUND', message: 'Owner account not found' }, 500)
  }

  // Cross-check: owners.email must match the email we verified. If it
  // doesn't, something is catastrophically wrong — bail rather than hand
  // out a session cookie scoped to the wrong account.
  if (owner.email !== userEmail.toLowerCase().trim()) {
    console.error('[dashboard] verified email mismatch with owners row', owner.id)
    return c.json({ code: 'OWNER_NOT_FOUND', message: 'Owner account not found' }, 500)
  }

  // Set the session cookie. httpOnly + SameSite=Lax + Secure in prod.
  // MaxAge matches the Supabase JWT default (1h). When the cookie/token
  // expires, the middleware returns 401 and the frontend re-OTPs.
  setCookie(c, DASHBOARD_SESSION_COOKIE, verifyData.session.access_token, {
    httpOnly: true,
    secure: process.env['NODE_ENV'] === 'production',
    sameSite: 'Lax',
    path: '/',
    maxAge: 3600,
  })

  return c.json({
    owner: {
      id: owner.id,
      email: owner.email,
      display_name: owner.display_name,
      created_at: owner.created_at,
    },
  })
})

// POST /dashboard/auth/logout — Clear the session cookie
dashboard.post('/auth/logout', async (c) => {
  deleteCookie(c, DASHBOARD_SESSION_COOKIE, { path: '/' })
  return c.json({ message: 'Logged out' })
})

// GET /dashboard/me — Return the signed-in owner
dashboard.get('/me', dashboardAuthMiddleware, async (c) => {
  const owner = c.get('owner')
  return c.json({
    id: owner.id,
    email: owner.email,
    display_name: owner.display_name,
    created_at: owner.created_at,
  })
})

// ─── Claim flow ────────────────────────────────────────────────────────────

// POST /dashboard/agents/claim — Paste API key, claim the agent
dashboard.post('/agents/claim', dashboardAuthMiddleware, async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }, 400)
  }
  const parsed = ClaimAgentRequest.safeParse(body)
  if (!parsed.success) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: 'Invalid request', details: parsed.error.flatten() },
      400,
    )
  }

  try {
    const ownerId = c.get('ownerId')
    const claimed = await claimAgent(ownerId, parsed.data.api_key)
    return c.json(claimed, 201)
  } catch (e) {
    if (e instanceof DashboardError) {
      return c.json({ code: e.code, message: e.message }, e.status as 404 | 409)
    }
    throw e
  }
})

// GET /dashboard/agents — List claimed agents for the signed-in owner
dashboard.get('/agents', dashboardAuthMiddleware, async (c) => {
  const ownerId = c.get('ownerId')
  const agents = await listAgentsForOwner(ownerId)
  return c.json({ agents })
})

// GET /dashboard/agents/:handle — Profile of one claimed agent
dashboard.get('/agents/:handle', dashboardAuthMiddleware, async (c) => {
  const handle = c.req.param('handle').replace(/^@/, '').toLowerCase()
  try {
    const ownerId = c.get('ownerId')
    const profile = await getAgentProfile(ownerId, handle)
    return c.json(profile)
  } catch (e) {
    if (e instanceof DashboardError) {
      return c.json({ code: e.code, message: e.message }, e.status as 404)
    }
    throw e
  }
})

// GET /dashboard/agents/:handle/conversations — List conversations
dashboard.get('/agents/:handle/conversations', dashboardAuthMiddleware, async (c) => {
  const handle = c.req.param('handle').replace(/^@/, '').toLowerCase()
  try {
    const ownerId = c.get('ownerId')
    const conversations = await getAgentConversationsForOwner(ownerId, handle)
    return c.json({ conversations })
  } catch (e) {
    if (e instanceof DashboardError) {
      return c.json({ code: e.code, message: e.message }, e.status as 404)
    }
    throw e
  }
})

// GET /dashboard/agents/:handle/messages?conversation_id=...&before_seq=...
dashboard.get('/agents/:handle/messages', dashboardAuthMiddleware, async (c) => {
  const handle = c.req.param('handle').replace(/^@/, '').toLowerCase()
  const conversationId = c.req.query('conversation_id')
  if (!conversationId) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'conversation_id is required' }, 400)
  }
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
    const ownerId = c.get('ownerId')
    const messages = await getAgentMessagesForOwner(ownerId, handle, conversationId, beforeSeq)
    return c.json({ messages })
  } catch (e) {
    if (e instanceof DashboardError) {
      return c.json({ code: e.code, message: e.message }, e.status as 404)
    }
    throw e
  }
})

// GET /dashboard/agents/:handle/events?before=iso
dashboard.get('/agents/:handle/events', dashboardAuthMiddleware, async (c) => {
  const handle = c.req.param('handle').replace(/^@/, '').toLowerCase()
  const beforeCreatedAt = c.req.query('before')
  try {
    const ownerId = c.get('ownerId')
    const events = await getAgentEventsForOwner(ownerId, handle, beforeCreatedAt)
    return c.json({ events })
  } catch (e) {
    if (e instanceof DashboardError) {
      return c.json({ code: e.code, message: e.message }, e.status as 404)
    }
    throw e
  }
})

// POST /dashboard/agents/:handle/pause — Pause in a specific mode
dashboard.post('/agents/:handle/pause', dashboardAuthMiddleware, async (c) => {
  const handle = c.req.param('handle').replace(/^@/, '').toLowerCase()
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }, 400)
  }
  const parsed = PauseRequest.safeParse(body)
  if (!parsed.success) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: 'Invalid request', details: parsed.error.flatten() },
      400,
    )
  }

  try {
    const ownerId = c.get('ownerId')
    const result = await pauseAgent(ownerId, handle, parsed.data.mode)
    return c.json(result)
  } catch (e) {
    if (e instanceof DashboardError) {
      return c.json({ code: e.code, message: e.message }, e.status as 404)
    }
    throw e
  }
})

// POST /dashboard/agents/:handle/unpause — Return to 'none'
dashboard.post('/agents/:handle/unpause', dashboardAuthMiddleware, async (c) => {
  const handle = c.req.param('handle').replace(/^@/, '').toLowerCase()
  try {
    const ownerId = c.get('ownerId')
    const result = await unpauseAgent(ownerId, handle)
    return c.json(result)
  } catch (e) {
    if (e instanceof DashboardError) {
      return c.json({ code: e.code, message: e.message }, e.status as 404)
    }
    throw e
  }
})

// DELETE /dashboard/agents/:handle — Release the claim
dashboard.delete('/agents/:handle', dashboardAuthMiddleware, async (c) => {
  const handle = c.req.param('handle').replace(/^@/, '').toLowerCase()
  try {
    const ownerId = c.get('ownerId')
    await releaseClaim(ownerId, handle)
    return c.json({ message: 'Claim released' })
  } catch (e) {
    if (e instanceof DashboardError) {
      return c.json({ code: e.code, message: e.message }, e.status as 404)
    }
    throw e
  }
})

export { dashboard as dashboardRoutes }
