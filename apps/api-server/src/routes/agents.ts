import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { AgentSettings, UpdateAgentRequest, VerifyRequest } from '@agentchat/shared'
import { authMiddleware, authAnyStatusMiddleware } from '../middleware/auth.js'
import { getAgent, updateAgent, deleteAgent, rotateApiKey, AgentError } from '../services/agent.service.js'
import {
  setAgentAvatar,
  removeAgentAvatar,
  buildAvatarUrl,
  AvatarError,
  MAX_AVATAR_INPUT_BYTES,
} from '../services/avatar.service.js'
import { checkAvatarWriteRateLimit } from '../services/enforcement.service.js'
import { avatarsWritten, rateLimitHits } from '../lib/metrics.js'
import { getSupabaseClient, findAgentById, findActiveAgentByEmail } from '@agentchat/db'
import {
  claimOtpSendSlot,
  releaseOtpSendSlot,
  registerOtpVerifyAttempt,
  clearOtpAttempts,
  OtpRateError,
} from '../services/otp.service.js'
import { getRedis } from '../lib/redis.js'
import { generateId } from '../lib/id.js'
import { ipRateLimit } from '../middleware/rate-limit.js'

const agents = new Hono()

// ─── Account Recovery (no API key needed — email-only) ─────────────────────
// These MUST be registered before /:handle routes to avoid "recover" matching as a param.

// POST /v1/agents/recover — Step 1: Send OTP to agent's email (no auth)
agents.post('/recover', ipRateLimit(3, 3600), async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }, 400)
  }

  const { email } = body as { email?: string }
  if (!email || typeof email !== 'string') {
    return c.json({ code: 'VALIDATION_ERROR', message: 'email is required' }, 400)
  }

  const normalizedEmail = email.toLowerCase().trim()
  const agent = await findActiveAgentByEmail(normalizedEmail)

  // Always return success message (don't leak whether email exists)
  const genericMsg = 'If an account is registered with this email, a verification code has been sent.'

  if (!agent) {
    return c.json({ message: genericMsg })
  }

  // Enforce cooldown + hourly cap on this email. We SWALLOW OtpRateError
  // here and return the generic success message — surfacing a "wait 60s"
  // response would let an attacker distinguish registered-but-rate-limited
  // from unregistered, defeating the whole reason recover uses a generic
  // response shape.
  try {
    await claimOtpSendSlot(normalizedEmail)
  } catch (e) {
    if (e instanceof OtpRateError) {
      return c.json({ message: genericMsg })
    }
    throw e
  }

  // Store pending recovery in Redis BEFORE sending OTP
  const pendingId = generateId('pnd')
  const redis = getRedis()
  await redis.set(`recover:${pendingId}`, JSON.stringify({ agent_id: agent.id, email: normalizedEmail }), { ex: 600 })

  const supabase = getSupabaseClient()
  const { error } = await supabase.auth.signInWithOtp({ email: normalizedEmail })

  if (error) {
    console.error('[recover] signInWithOtp failed:', error.message, error.code, error.status)
    await redis.del(`recover:${pendingId}`).catch(() => {})
    await releaseOtpSendSlot(normalizedEmail)
    // Still return generic success to avoid leaking info
    return c.json({ message: genericMsg })
  }

  return c.json({ pending_id: pendingId, message: genericMsg })
})

// POST /v1/agents/recover/verify — Step 2: Verify OTP and get new API key (no auth)
agents.post('/recover/verify', ipRateLimit(10, 600), async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }, 400)
  }

  const parsed = VerifyRequest.safeParse(body)
  if (!parsed.success) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid request', details: parsed.error.flatten() }, 400)
  }

  const { pending_id, code } = parsed.data
  const redis = getRedis()
  const raw = await redis.get<string>(`recover:${pending_id}`)

  if (!raw) {
    return c.json({ code: 'EXPIRED', message: 'Recovery request expired. Please start again.' }, 400)
  }

  const pending = typeof raw === 'string' ? JSON.parse(raw) : raw

  // Cap verify attempts against this pending_id. On overflow the pending
  // is burned so the attacker can't keep probing the 6-digit code space.
  try {
    await registerOtpVerifyAttempt(pending_id, 'recover:')
  } catch (e) {
    if (e instanceof OtpRateError) {
      if (e.retryAfterSeconds) c.header('Retry-After', String(e.retryAfterSeconds))
      return c.json({ code: e.code, message: e.message }, 429)
    }
    throw e
  }

  // Verify OTP
  const supabase = getSupabaseClient()
  const { error: verifyError } = await supabase.auth.verifyOtp({
    email: pending.email,
    token: code,
    type: 'email',
  })

  if (verifyError) {
    return c.json({ code: 'INVALID_CODE', message: 'Invalid or expired verification code' }, 400)
  }

  // Delete pending immediately to prevent replay
  await redis.del(`recover:${pending_id}`)
  await clearOtpAttempts(pending_id)

  // Generate new API key (this is effectively a forced rotation)
  try {
    const result = await rotateApiKey(pending.agent_id, pending.agent_id)
    return c.json(result)
  } catch (e) {
    if (e instanceof AgentError) {
      return c.json({ code: e.code, message: e.message }, e.status as 403 | 404)
    }
    throw e
  }
})

// ─── Self-status (works even when suspended) ──────────────────────────────

// Mask the registered email so a suspended agent can identify which address
// to use with POST /v1/agents/recover without the response leaking the full
// address on disk or in shared logs. Format: first char + **** + @ + domain.
function maskEmail(email: string): string {
  const at = email.indexOf('@')
  if (at <= 0) return email
  const first = email[0] ?? ''
  return `${first}****@${email.slice(at + 1)}`
}

// GET /v1/agents/me — Get own account status (works for all non-deleted accounts)
// Registered BEFORE /:handle to avoid "me" matching as a handle param.
//
// Settings are normalized through the shared Zod schema so agents registered
// before a given settings field existed (e.g. pre-groups accounts that
// never got `group_invite_policy` persisted in their JSONB column) still
// see the defaulted value on read. This is the single place the defaults
// are materialized for the wire — the server-side enforcement code
// already falls back to the same defaults inline when reading raw JSON.
agents.get('/me', authAnyStatusMiddleware, async (c) => {
  const agent = c.get('agent')
  const normalizedSettings = AgentSettings.parse(agent.settings ?? {})
  return c.json({
    handle: agent.handle,
    display_name: agent.display_name,
    description: agent.description,
    avatar_url: buildAvatarUrl(agent.avatar_key as string | null | undefined),
    status: agent.status,
    // paused_by_owner is surfaced here so the agent's own tooling can
    // detect the state and stop retrying sends. Pre-migration rows
    // default to 'none' at the DB level, so an undefined coming back
    // from the row (older in-memory caches) still resolves safely.
    paused_by_owner: agent.paused_by_owner ?? 'none',
    settings: normalizedSettings,
    email_masked: maskEmail(agent.email),
    created_at: agent.created_at,
  })
})

// ─── Public profile ────────────────────────────────────────────────────────

// GET /v1/agents/:handle — Get agent profile (public, no auth)
agents.get('/:handle', async (c) => {
  const handle = c.req.param('handle').replace(/^@/, '').toLowerCase()
  try {
    const agent = await getAgent(handle)
    return c.json(agent)
  } catch (e) {
    if (e instanceof AgentError) {
      return c.json({ code: e.code, message: e.message }, e.status as 404)
    }
    throw e
  }
})

// ─── Self-management (agent auth via API key) ──────────────────────────────

// PATCH /v1/agents/:handle — Update own profile
agents.patch('/:handle', authMiddleware, async (c) => {
  const handle = c.req.param('handle').replace(/^@/, '').toLowerCase()
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }, 400)
  }

  const parsed = UpdateAgentRequest.safeParse(body)
  if (!parsed.success) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid request', details: parsed.error.flatten() }, 400)
  }

  try {
    // Resolve handle to internal ID, then verify ownership
    const agentId = c.get('agentId')
    const authedAgent = await findAgentById(agentId)
    if (!authedAgent || authedAgent.handle !== handle) {
      return c.json({ code: 'FORBIDDEN', message: 'You can only update your own account' }, 403)
    }
    const agent = await updateAgent(agentId, parsed.data, agentId)
    return c.json(agent)
  } catch (e) {
    if (e instanceof AgentError) {
      return c.json({ code: e.code, message: e.message }, e.status as 400 | 403 | 404)
    }
    throw e
  }
})

// DELETE /v1/agents/:handle — Delete own agent (soft delete)
agents.delete('/:handle', authMiddleware, async (c) => {
  const handle = c.req.param('handle').replace(/^@/, '').toLowerCase()
  try {
    const agentId = c.get('agentId')
    const authedAgent = await findAgentById(agentId)
    if (!authedAgent || authedAgent.handle !== handle) {
      return c.json({ code: 'FORBIDDEN', message: 'You can only delete your own account' }, 403)
    }
    await deleteAgent(agentId, agentId)
    return c.json({ message: 'Account deleted' })
  } catch (e) {
    if (e instanceof AgentError) {
      return c.json({ code: e.code, message: e.message }, e.status as 403 | 404)
    }
    throw e
  }
})

// ─── Avatar upload / remove ────────────────────────────────────────────────
//
// PUT  /v1/agents/:handle/avatar — upload a new avatar (raw image bytes in
//                                   the request body, any Content-Type that
//                                   starts with image/* or application/octet-
//                                   stream is accepted; format is authoritatively
//                                   determined by magic-byte sniff server-side).
// DELETE /v1/agents/:handle/avatar — clear the avatar; dashboard falls back
//                                   to the handle-initial-on-hashed-color default.
//
// Why raw bytes rather than multipart/form-data: the body IS the avatar, no
// other fields are relevant. Multipart adds boundary parsing overhead on the
// server and FormData construction cost in the SDK for no value. A raw-body
// endpoint is what the WhatsApp and Telegram media upload paths do for the
// same reason.
//
// Authorization is the same pattern as PATCH /:handle — authMiddleware puts
// the caller's agent id on ctx, we resolve the handle to its row, and 403
// if they don't match. Rate-limit is a separate per-minute bucket from
// mute/message writes so a burst of avatar changes can't eat a user's
// send budget.

type AvatarErrorStatus = 400 | 403 | 404 | 413 | 500 | 503

function respondAvatarError(c: Context, e: AvatarError) {
  return c.json({ code: e.code, message: e.message }, e.status as AvatarErrorStatus)
}

async function guardAvatarWriteRate(c: Context, agentId: string) {
  const check = await checkAvatarWriteRateLimit(agentId)
  if (check.allowed) return null
  rateLimitHits.inc({ rule: 'avatar_write' })
  avatarsWritten.inc({ outcome: 'rate_limited' })
  if (check.retryAfterMs != null) {
    c.header('Retry-After', String(Math.ceil(check.retryAfterMs / 1000)))
  }
  return c.json(
    {
      code: 'RATE_LIMITED',
      message: 'Too many avatar writes per minute',
      retry_after_ms: check.retryAfterMs,
    },
    429,
  )
}

// The bodyLimit middleware rejects with 413 before the handler ever runs
// so a malicious client flooding with huge payloads can't wedge the event
// loop buffering gigabytes. The limit is identical to the one enforced
// in processAvatarImage — belt-and-suspenders because bodyLimit is the
// cheap early gate and the service-layer check is the authoritative one
// for direct service callers (tests, future RPC).
const avatarBodyLimit = bodyLimit({
  maxSize: MAX_AVATAR_INPUT_BYTES,
  onError: (c) =>
    c.json(
      {
        code: 'PAYLOAD_TOO_LARGE',
        message: `Avatar exceeds the ${Math.floor(MAX_AVATAR_INPUT_BYTES / 1024 / 1024)} MB cap`,
      },
      413,
    ),
})

agents.put('/:handle/avatar', authMiddleware, avatarBodyLimit, async (c) => {
  const handle = c.req.param('handle').replace(/^@/, '').toLowerCase()
  const agentId = c.get('agentId')

  const authedAgent = await findAgentById(agentId)
  if (!authedAgent || authedAgent.handle !== handle) {
    return c.json({ code: 'FORBIDDEN', message: 'You can only update your own avatar' }, 403)
  }

  const rateLimited = await guardAvatarWriteRate(c, agentId)
  if (rateLimited) return rateLimited

  // Read the full body as a Buffer. bodyLimit already capped the size so
  // this cannot OOM. arrayBuffer() is the web-standard way to get raw bytes
  // in Hono; the Node adapter streams into a single allocation under the
  // hood.
  let bytes: Buffer
  try {
    const ab = await c.req.arrayBuffer()
    bytes = Buffer.from(ab)
  } catch (e) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: `Could not read request body: ${(e as Error).message}` },
      400,
    )
  }

  try {
    const result = await setAgentAvatar(agentId, bytes)
    return c.json(result)
  } catch (e) {
    if (e instanceof AvatarError) return respondAvatarError(c, e)
    throw e
  }
})

agents.delete('/:handle/avatar', authMiddleware, async (c) => {
  const handle = c.req.param('handle').replace(/^@/, '').toLowerCase()
  const agentId = c.get('agentId')

  const authedAgent = await findAgentById(agentId)
  if (!authedAgent || authedAgent.handle !== handle) {
    return c.json({ code: 'FORBIDDEN', message: 'You can only update your own avatar' }, 403)
  }

  const rateLimited = await guardAvatarWriteRate(c, agentId)
  if (rateLimited) return rateLimited

  try {
    const { existed } = await removeAgentAvatar(agentId)
    if (!existed) {
      return c.json({ code: 'NOT_FOUND', message: 'No avatar set' }, 404)
    }
    return c.json({ ok: true })
  } catch (e) {
    if (e instanceof AvatarError) return respondAvatarError(c, e)
    throw e
  }
})

// ─── API Key Rotation (two-step OTP, requires current API key) ─────────────

// POST /v1/agents/:handle/rotate-key — Step 1: Send OTP
agents.post('/:handle/rotate-key', authMiddleware, ipRateLimit(3, 3600), async (c) => {
  const handle = c.req.param('handle').replace(/^@/, '').toLowerCase()
  const agentId = c.get('agentId')

  const authedAgent = await findAgentById(agentId)
  if (!authedAgent || authedAgent.handle !== handle) {
    return c.json({ code: 'FORBIDDEN', message: 'You can only rotate your own API key' }, 403)
  }

  if (authedAgent.status === 'deleted') {
    return c.json({ code: 'AGENT_NOT_FOUND', message: 'Account not found' }, 404)
  }

  // Rotate-key is authenticated, so surfacing the rate-limit directly is
  // fine — there's no enumeration risk. Claim enforces the 60s cooldown
  // and 20/hr cap against the agent's registered email address.
  try {
    await claimOtpSendSlot(authedAgent.email)
  } catch (e) {
    if (e instanceof OtpRateError) {
      if (e.retryAfterSeconds) c.header('Retry-After', String(e.retryAfterSeconds))
      return c.json({ code: e.code, message: e.message }, 429)
    }
    throw e
  }

  // Store pending rotation in Redis BEFORE sending OTP
  const pendingId = generateId('pnd')
  const redis = getRedis()
  await redis.set(`rotate:${pendingId}`, JSON.stringify({ agent_id: agentId, email: authedAgent.email }), { ex: 600 })

  const supabase = getSupabaseClient()
  const { error } = await supabase.auth.signInWithOtp({ email: authedAgent.email })

  if (error) {
    console.error('[rotate-key] signInWithOtp failed:', error.message, error.code, error.status)
    await redis.del(`rotate:${pendingId}`).catch(() => {})
    await releaseOtpSendSlot(authedAgent.email)
    return c.json({ code: 'OTP_FAILED', message: 'Failed to send verification code' }, 500)
  }

  return c.json({ pending_id: pendingId, message: 'Verification code sent to registered email' })
})

// POST /v1/agents/:handle/rotate-key/verify — Step 2: Verify OTP and rotate
agents.post('/:handle/rotate-key/verify', authMiddleware, ipRateLimit(10, 600), async (c) => {
  const handle = c.req.param('handle').replace(/^@/, '').toLowerCase()
  const agentId = c.get('agentId')

  const authedAgent = await findAgentById(agentId)
  if (!authedAgent || authedAgent.handle !== handle) {
    return c.json({ code: 'FORBIDDEN', message: 'You can only rotate your own API key' }, 403)
  }

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }, 400)
  }

  const parsed = VerifyRequest.safeParse(body)
  if (!parsed.success) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid request', details: parsed.error.flatten() }, 400)
  }

  const { pending_id, code } = parsed.data
  const redis = getRedis()
  const raw = await redis.get<string>(`rotate:${pending_id}`)

  if (!raw) {
    return c.json({ code: 'EXPIRED', message: 'Rotation request expired. Please start again.' }, 400)
  }

  const pending = typeof raw === 'string' ? JSON.parse(raw) : raw

  if (pending.agent_id !== agentId) {
    return c.json({ code: 'FORBIDDEN', message: 'Invalid rotation request' }, 403)
  }

  // Cap brute-force attempts against this pending_id. Scoped with the
  // 'rotate:' prefix so the burn-on-overflow evicts the right key.
  try {
    await registerOtpVerifyAttempt(pending_id, 'rotate:')
  } catch (e) {
    if (e instanceof OtpRateError) {
      if (e.retryAfterSeconds) c.header('Retry-After', String(e.retryAfterSeconds))
      return c.json({ code: e.code, message: e.message }, 429)
    }
    throw e
  }

  // Verify OTP
  const supabase = getSupabaseClient()
  const { error: verifyError } = await supabase.auth.verifyOtp({
    email: pending.email,
    token: code,
    type: 'email',
  })

  if (verifyError) {
    return c.json({ code: 'INVALID_CODE', message: 'Invalid or expired verification code' }, 400)
  }

  // Delete pending immediately to prevent replay
  await redis.del(`rotate:${pending_id}`)
  await clearOtpAttempts(pending_id)

  try {
    const result = await rotateApiKey(agentId, agentId)
    return c.json(result)
  } catch (e) {
    if (e instanceof AgentError) {
      return c.json({ code: e.code, message: e.message }, e.status as 403 | 404)
    }
    throw e
  }
})

export { agents as agentRoutes }
