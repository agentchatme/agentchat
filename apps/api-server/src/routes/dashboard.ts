import { createHash } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { setCookie, getCookie, deleteCookie } from 'hono/cookie'
import {
  DashboardOtpRequest,
  DashboardOtpVerify,
  ClaimAgentRequest,
  PauseRequest,
} from '@agentchat/shared'
import {
  getSupabaseClient,
  findActiveAgentByEmail,
  findOwnerById,
  insertOwner,
  insertDashboardSession,
  findDashboardSessionByHash,
  rotateDashboardSession,
  deleteDashboardSessionByHash,
  deleteDashboardSessionsForOwner,
} from '@agentchat/db'
import {
  dashboardAuthMiddleware,
  DASHBOARD_SESSION_COOKIE,
  DASHBOARD_REFRESH_COOKIE,
  DASHBOARD_ACCESS_COOKIE_MAX_AGE,
  DASHBOARD_REFRESH_COOKIE_MAX_AGE,
} from '../middleware/dashboard-auth.js'
import { serverTimingMiddleware } from '../middleware/server-timing.js'
import { ipRateLimit, resolveClientIp } from '../middleware/rate-limit.js'
import { generateId } from '../lib/id.js'
import { env } from '../env.js'
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
  getAgentContactsForOwner,
  getAgentBlocksForOwner,
  getAgentPresenceForOwner,
  pauseAgent,
  unpauseAgent,
  DashboardError,
} from '../services/dashboard.service.js'
import { getRedis } from '../lib/redis.js'
import { emitEvent } from '../services/events.service.js'
import { issueTicket } from '../ws/ticket-store.js'
import { publishOwnerSignout } from '../ws/pubsub.js'

const dashboard = new Hono()

// Server-Timing is the first middleware on the chain so its `total`
// captures every millisecond of every /dashboard/* request: auth
// verification, handler work, response serialization, error handling.
// The header is emitted unconditionally (success, 4xx, 5xx) so DevTools
// can observe slow failure paths without any extra instrumentation.
dashboard.use('*', serverTimingMiddleware)

// ─── Session cookie helpers ────────────────────────────────────────────────
// Two cookies, set together on every auth-state transition (verify, refresh):
//   ac_dashboard_session — short-lived Supabase access token (1h)
//   ac_dashboard_refresh — long-lived refresh token (30d), rotated on use
//
// Both are HttpOnly + Secure (prod) + SameSite=Lax + Path=/. The refresh
// token never lives on the server except as a SHA-256 hash in the
// dashboard_sessions row — so a DB read leak cannot be replayed.

function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function setSessionCookies(c: Context, accessToken: string, refreshToken: string) {
  const secure = process.env['NODE_ENV'] === 'production'
  setCookie(c, DASHBOARD_SESSION_COOKIE, accessToken, {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/',
    maxAge: DASHBOARD_ACCESS_COOKIE_MAX_AGE,
  })
  setCookie(c, DASHBOARD_REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/',
    maxAge: DASHBOARD_REFRESH_COOKIE_MAX_AGE,
  })
}

function clearSessionCookies(c: Context) {
  deleteCookie(c, DASHBOARD_SESSION_COOKIE, { path: '/' })
  deleteCookie(c, DASHBOARD_REFRESH_COOKIE, { path: '/' })
}

interface SupabaseTokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  token_type: string
  user: { id: string; email?: string }
}

// Direct REST call to Supabase /auth/v1/token?grant_type=refresh_token.
// We deliberately bypass supabase-js because our singleton client is
// configured stateless (persistSession:false, autoRefreshToken:false) to
// keep service_role locked in for DB + Storage — calling refreshSession()
// on it would plant the refreshed user's access token into the SDK's
// in-memory state and poison every subsequent service-role call on this
// process. A raw fetch sidesteps all of that.
async function callSupabaseRefresh(
  refreshToken: string,
): Promise<SupabaseTokenResponse | null> {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ refresh_token: refreshToken }),
  })
  if (!res.ok) return null
  try {
    return (await res.json()) as SupabaseTokenResponse
  } catch {
    return null
  }
}

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

  // Persist the refresh token as a session row so we can rotate it and
  // so sign-out-everywhere is a single DELETE. Only the SHA-256 hash is
  // stored — the raw refresh token goes straight into the browser cookie
  // and never lives server-side afterwards.
  const refreshToken = verifyData.session.refresh_token
  await insertDashboardSession({
    id: generateId('dsh'),
    owner_id: owner.id,
    refresh_token_hash: hashRefreshToken(refreshToken),
  })

  setSessionCookies(c, verifyData.session.access_token, refreshToken)

  // Log every successful sign-in (account creation already emitted
  // owner.created above — this covers returning owners). Used by the
  // audit log; one row per session start, NOT per refresh, so the
  // events table doesn't flood.
  await emitEvent({
    actorType: 'owner',
    actorId: owner.id,
    action: 'owner.signed_in',
    targetId: owner.id,
  })

  // owner.id is the Supabase auth user UUID — internal, never surfaced
  // on the wire. The owner is addressed by email everywhere in the UI.
  return c.json({
    owner: {
      email: owner.email,
      display_name: owner.display_name,
      created_at: owner.created_at,
    },
  })
})

// ─── Single-flight refresh coordination ──────────────────────────────────
// A naive rotate-on-use refresh endpoint races itself whenever siblings
// fire concurrently with the same cookie — common in real use from Next's
// RSC prefetches, WS-driven router.refresh() bursts, the 40-min keepalive,
// or multiple tabs. The loser of the DB UPDATE race would surface 401,
// the dashboard middleware would see it as auth death and kick to /login.
//
// Strategy:
//   1. Check Redis for `refresh:result:<oldHash>` — if a sibling already
//      rotated in the last ~30s, reuse its tokens.
//   2. Otherwise SETNX `refresh:lock:<oldHash>` (10s TTL) to win the right
//      to do the rotation. Losers poll the result key briefly.
//   3. Winner does the full Supabase + DB rotation, caches the plaintext
//      new tokens under the OLD hash for 30s, releases the lock.
//
// The plaintext tokens live in Redis for at most ~30s. The refresh token
// already exists in plaintext in the browser cookie, so a short Redis
// cache is not a meaningful widening of the attack surface.

const REFRESH_LOCK_TTL_MS = 10_000
const REFRESH_RESULT_TTL_S = 30
const REFRESH_POLL_INTERVAL_MS = 75
const REFRESH_POLL_ATTEMPTS = 30

interface CachedRotation {
  access: string
  refresh: string
}

function refreshResultKey(oldHash: string): string {
  return `refresh:result:${oldHash}`
}

function refreshLockKey(oldHash: string): string {
  return `refresh:lock:${oldHash}`
}

async function getCachedRotation(oldHash: string): Promise<CachedRotation | null> {
  try {
    const v = await getRedis().get<CachedRotation>(refreshResultKey(oldHash))
    return v ?? null
  } catch {
    return null
  }
}

async function cacheRotation(oldHash: string, tokens: CachedRotation): Promise<void> {
  try {
    await getRedis().set(refreshResultKey(oldHash), tokens, {
      ex: REFRESH_RESULT_TTL_S,
    })
  } catch {
    // best-effort — a miss just degrades to the same race we had before
  }
}

async function acquireRefreshLock(oldHash: string): Promise<boolean> {
  try {
    const ok = await getRedis().set(refreshLockKey(oldHash), '1', {
      nx: true,
      px: REFRESH_LOCK_TTL_MS,
    })
    return ok === 'OK'
  } catch {
    return false
  }
}

async function releaseRefreshLock(oldHash: string): Promise<void> {
  try {
    await getRedis().del(refreshLockKey(oldHash))
  } catch {
    // lock TTL is the safety net
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// POST /dashboard/auth/refresh — Rotate session using the refresh cookie
// Called by the dashboard's Next.js middleware when the access token is
// close to expiry (or already expired). Returns 200 on success with new
// cookies set via Set-Cookie, 401 only on real auth death so the
// middleware knows to redirect to /login.
//
// Rate limit: 30/min per IP. A single tab rotates at most once per ~1h of
// active use, so 30/min is a hard ceiling against an attacker replaying
// a stolen refresh cookie — real traffic can't come close.
dashboard.post('/auth/refresh', ipRateLimit(30, 60), async (c) => {
  const refreshToken = getCookie(c, DASHBOARD_REFRESH_COOKIE)
  if (!refreshToken) {
    return c.json({ code: 'UNAUTHORIZED', message: 'No refresh token' }, 401)
  }

  const oldHash = hashRefreshToken(refreshToken)

  // Fast path: a concurrent sibling already rotated this token. Reuse
  // its result so every caller with the same old cookie ends up with
  // the same new cookies — no DB UPDATE contention, no false 401.
  const cached = await getCachedRotation(oldHash)
  if (cached) {
    setSessionCookies(c, cached.access, cached.refresh)
    return c.json({ message: 'Refreshed' })
  }

  // Single-flight: only one request at a time performs the Supabase +
  // DB rotation for a given refresh cookie. Losers wait briefly for
  // the winner's cached result.
  const gotLock = await acquireRefreshLock(oldHash)
  if (!gotLock) {
    for (let i = 0; i < REFRESH_POLL_ATTEMPTS; i++) {
      await sleep(REFRESH_POLL_INTERVAL_MS)
      const result = await getCachedRotation(oldHash)
      if (result) {
        setSessionCookies(c, result.access, result.refresh)
        return c.json({ message: 'Refreshed' })
      }
    }
    // Winner never cached — likely crashed mid-rotation or Redis is
    // down. Surface 503 so the middleware retries instead of kicking.
    return c.json({ code: 'REFRESH_UNAVAILABLE', message: 'Refresh coordinator timeout' }, 503)
  }

  try {
    // Re-check the cache — the lock winner could have finished between
    // our first cache check and our SETNX. Cheap insurance against
    // doing the rotation twice in that narrow window.
    const postLock = await getCachedRotation(oldHash)
    if (postLock) {
      setSessionCookies(c, postLock.access, postLock.refresh)
      return c.json({ message: 'Refreshed' })
    }

    const session = await findDashboardSessionByHash(oldHash)
    if (!session) {
      clearSessionCookies(c)
      return c.json({ code: 'UNAUTHORIZED', message: 'Session not found' }, 401)
    }

    const tokens = await callSupabaseRefresh(refreshToken)
    if (!tokens) {
      // Supabase rejected the refresh token — expired (30d idle), revoked,
      // or malformed. Drop the row so a later replay attempt can't brute
      // the same hash, and clear cookies.
      await deleteDashboardSessionByHash(oldHash).catch(() => {})
      clearSessionCookies(c)
      return c.json({ code: 'UNAUTHORIZED', message: 'Session expired' }, 401)
    }

    const rotated = await rotateDashboardSession({
      old_hash: oldHash,
      new_hash: hashRefreshToken(tokens.refresh_token),
    })
    if (!rotated) {
      // We hold the lock yet the UPDATE found no row. Either the session
      // was just deleted (sign-out-everywhere, logout) or the lock TTL
      // expired and a sibling rotated out from under us. Treat as auth
      // death rather than masquerade with stale tokens.
      clearSessionCookies(c)
      return c.json({ code: 'UNAUTHORIZED', message: 'Rotation conflict' }, 401)
    }

    await cacheRotation(oldHash, {
      access: tokens.access_token,
      refresh: tokens.refresh_token,
    })

    setSessionCookies(c, tokens.access_token, tokens.refresh_token)
    return c.json({ message: 'Refreshed' })
  } finally {
    await releaseRefreshLock(oldHash)
  }
})

// POST /dashboard/auth/logout — Sign out the current browser only
// Deletes the single dashboard_sessions row keyed by the refresh-cookie
// hash and clears both cookies. No auth required — an already-expired
// access token must still be able to complete a clean logout. No event
// emitted for common-case logout so the audit log stays signal-dense.
dashboard.post('/auth/logout', async (c) => {
  const refreshToken = getCookie(c, DASHBOARD_REFRESH_COOKIE)
  if (refreshToken) {
    await deleteDashboardSessionByHash(hashRefreshToken(refreshToken)).catch(() => {})
  }
  clearSessionCookies(c)
  return c.json({ message: 'Logged out' })
})

// POST /dashboard/auth/logout/all — Sign out of every browser
// Requires a valid access token so we know WHICH owner is asking; a 401
// here means the access cookie expired and the dashboard's Next.js
// middleware should have refreshed it before this request arrived.
// Emits owner.signed_out_all with the revoked count so the audit log
// captures the explicit cross-device action.
dashboard.post('/auth/logout/all', dashboardAuthMiddleware, async (c) => {
  const ownerId = c.get('ownerId')
  const revoked = await deleteDashboardSessionsForOwner(ownerId)
  clearSessionCookies(c)
  // Kick every dashboard WS on every host. Refresh tokens are gone, but
  // existing open sockets were authenticated off an access token that may
  // still verify for up to an hour — close them proactively so a stale
  // tab can't keep receiving fan-out (WIRE-CONTRACT lurker invariant §5).
  publishOwnerSignout(ownerId)
  await emitEvent({
    actorType: 'owner',
    actorId: ownerId,
    action: 'owner.signed_out_all',
    targetId: ownerId,
    metadata: { sessions_revoked: revoked },
  })
  return c.json({ message: 'Signed out of all devices', sessions_revoked: revoked })
})

// GET /dashboard/me — Return the signed-in owner
dashboard.get('/me', dashboardAuthMiddleware, async (c) => {
  const owner = c.get('owner')
  return c.json({
    email: owner.email,
    display_name: owner.display_name,
    created_at: owner.created_at,
  })
})

// GET /dashboard/bootstrap — Single-call page bootstrap for the Next.js
// (app) layout. Returns the signed-in owner AND the claimed-agents list
// in one authenticated round-trip, so the layout no longer has to await
// /dashboard/me followed by /dashboard/agents. Cuts one hop × network
// RTT off every dashboard navigation.
//
// Security invariant is unchanged: every field surfaced here already
// goes out via /dashboard/me and /dashboard/agents individually, and
// the middleware gate is the same one they use. No internal row ids
// (owner.id, agent.id) are included — owner is addressed by email,
// agents by @handle throughout.
dashboard.get('/bootstrap', dashboardAuthMiddleware, async (c) => {
  const owner = c.get('owner')
  const ownerId = c.get('ownerId')
  const agents = await listAgentsForOwner(ownerId)
  return c.json({
    owner: {
      email: owner.email,
      display_name: owner.display_name,
      created_at: owner.created_at,
    },
    agents,
  })
})

// ─── Claim flow ────────────────────────────────────────────────────────────

// POST /dashboard/agents/claim — Paste API key, claim the agent
// Rate limit: 20 attempts per IP per 10 minutes. An API key is 256 bits
// of entropy so brute forcing is infeasible regardless, but this caps
// DoS against the SHA-256 + DB lookup path and blunts any timing-oracle
// probing (e.g. distinguishing 404 INVALID_API_KEY vs 409 ALREADY_CLAIMED
// response times to enumerate valid prefixes).
dashboard.post('/agents/claim', ipRateLimit(20, 600), dashboardAuthMiddleware, async (c) => {
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
    const ip = resolveClientIp(c)
    const userAgent = c.req.header('user-agent')
    const claimed = await claimAgent(ownerId, parsed.data.api_key, {
      ip,
      userAgent,
    })
    return c.json(claimed, 201)
  } catch (e) {
    if (e instanceof DashboardError) {
      return c.json(
        { code: e.code, message: e.message },
        e.status as 404 | 409 | 429,
      )
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

// GET /dashboard/agents/:handle/contacts — List the agent's contact book
// Read-only. Returns { contacts, total, limit, offset } with each contact
// carrying handle, display_name, description, notes, added_at.
dashboard.get('/agents/:handle/contacts', dashboardAuthMiddleware, async (c) => {
  const handle = c.req.param('handle').replace(/^@/, '').toLowerCase()
  try {
    const ownerId = c.get('ownerId')
    const result = await getAgentContactsForOwner(ownerId, handle)
    return c.json(result)
  } catch (e) {
    if (e instanceof DashboardError) {
      return c.json({ code: e.code, message: e.message }, e.status as 404)
    }
    throw e
  }
})

// GET /dashboard/agents/:handle/blocks — List the agent's block list
// Read-only. Returns { blocks, total, limit, offset }. Soft-deleted
// blocked agents are filtered out server-side so the owner never sees
// a row that points at a non-existent handle.
dashboard.get('/agents/:handle/blocks', dashboardAuthMiddleware, async (c) => {
  const handle = c.req.param('handle').replace(/^@/, '').toLowerCase()
  try {
    const ownerId = c.get('ownerId')
    const result = await getAgentBlocksForOwner(ownerId, handle)
    return c.json(result)
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

// POST /dashboard/ws/ticket — Mint a one-shot WS ticket (30s TTL)
// The dashboard hits this before opening /v1/ws/dashboard so the native
// WebSocket constructor can pass the ticket as a query param without
// putting the session cookie on the URL. See WIRE-CONTRACT §1.
dashboard.post('/ws/ticket', dashboardAuthMiddleware, async (c) => {
  const ownerId = c.get('ownerId')
  const ticket = await issueTicket(ownerId)
  return c.json({ ticket, expires_in: 30 })
})

// GET /dashboard/agents/:handle/presence — Get live presence for an owned agent
// The owner doesn't need contact-scoping — they own the agent, so they can
// always see its presence state. Returns the same Presence shape as the
// agent-facing GET /v1/presence/:handle.
dashboard.get('/agents/:handle/presence', dashboardAuthMiddleware, async (c) => {
  const handle = c.req.param('handle').replace(/^@/, '').toLowerCase()
  try {
    const ownerId = c.get('ownerId')
    const result = await getAgentPresenceForOwner(ownerId, handle)
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
