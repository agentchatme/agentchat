import { Hono } from 'hono'
import { randomBytes, createHash } from 'node:crypto'
import { CHATFATHER_AGENT_ID, RegisterRequest, VerifyRequest } from '@agentchat/shared'
import { isValidHandle } from '@agentchat/shared'
import { getSupabaseClient, findActiveAgentByEmail, findActiveOwnerByEmail, countAgentsByEmail, insertAgent } from '@agentchat/db'
import { isHandleAvailable } from '../services/agent.service.js'
import {
  claimOtpSendSlot,
  releaseOtpSendSlot,
  registerOtpVerifyAttempt,
  clearOtpAttempts,
  OtpRateError,
} from '../services/otp.service.js'
import { fireWebhooks } from '../services/webhook.service.js'
import { generateId } from '../lib/id.js'
import { getRedis } from '../lib/redis.js'
import { ipRateLimit } from '../middleware/rate-limit.js'

const register = new Hono()

const PENDING_TTL = 600 // 10 minutes

interface PendingRegistration {
  email: string
  handle: string
  display_name?: string
  description?: string
}

// POST /v1/register — Initiate agent registration (send OTP)
register.post('/', ipRateLimit(5, 3600), async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }, 400)
  }

  const parsed = RegisterRequest.safeParse(body)
  if (!parsed.success) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid request', details: parsed.error.flatten() }, 400)
  }

  // Normalize inputs
  const email = parsed.data.email.toLowerCase().trim()
  const handle = parsed.data.handle.toLowerCase().trim()
  const { display_name, description } = parsed.data

  // Validate handle (format + reserved words)
  if (!isValidHandle(handle)) {
    return c.json({ code: 'INVALID_HANDLE', message: 'Handle is invalid or reserved' }, 400)
  }

  // Check handle availability, active email, owner-namespace, and lifetime
  // email count in parallel. The owner-namespace check is the app-layer guard
  // that prevents a human creating an agent account with the same email they
  // use for the dashboard — the DB trigger enforce_email_namespace_isolation
  // catches any race, but surfacing a clean error here avoids the 500.
  const [handleAvailable, activeAgent, activeOwner, emailCount] = await Promise.all([
    isHandleAvailable(handle),
    findActiveAgentByEmail(email),
    findActiveOwnerByEmail(email),
    countAgentsByEmail(email),
  ])

  if (!handleAvailable) {
    return c.json({ code: 'HANDLE_TAKEN', message: `Handle @${handle} is already taken` }, 409)
  }

  if (activeAgent) {
    return c.json({ code: 'EMAIL_TAKEN', message: 'An account is already registered with this email. Delete it first to create a new one.' }, 409)
  }

  if (activeOwner) {
    return c.json({ code: 'EMAIL_IS_OWNER', message: 'This email is registered for the owner dashboard. Use a different email for the agent account.' }, 409)
  }

  if (emailCount >= 3) {
    return c.json({ code: 'EMAIL_EXHAUSTED', message: 'This email has reached the maximum of 3 account registrations.' }, 409)
  }

  // Claim an OTP send slot BEFORE touching Redis or Supabase. This enforces
  // the 60s per-email cooldown and the 20/hr per-email cap. Rejecting here
  // means we never write a pending record we'd only throw away.
  try {
    await claimOtpSendSlot(email)
  } catch (e) {
    if (e instanceof OtpRateError) {
      if (e.retryAfterSeconds) c.header('Retry-After', String(e.retryAfterSeconds))
      return c.json({ code: e.code, message: e.message }, 429)
    }
    throw e
  }

  // Store pending registration in Redis BEFORE sending OTP
  // (if Redis fails, we don't waste an OTP code)
  const pendingId = generateId('pnd')
  const pending: PendingRegistration = { email, handle, display_name, description }

  const redis = getRedis()
  await redis.set(`pending:${pendingId}`, JSON.stringify(pending), { ex: PENDING_TTL })

  // Send OTP via Supabase Auth
  const supabase = getSupabaseClient()
  const { error } = await supabase.auth.signInWithOtp({ email })

  if (error) {
    console.error('[register] signInWithOtp failed:', error.message, error.code, error.status)
    // Clean up pending since OTP failed and release the claimed slot so
    // the user isn't locked out of retrying for 60s over our flakiness.
    await redis.del(`pending:${pendingId}`).catch(() => {})
    await releaseOtpSendSlot(email)
    return c.json({ code: 'OTP_FAILED', message: 'Failed to send verification code' }, 500)
  }

  return c.json({ pending_id: pendingId, message: 'Verification code sent to email' })
})

// POST /v1/register/verify — Verify OTP and create agent
register.post('/verify', ipRateLimit(10, 600), async (c) => {
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

  // Retrieve pending registration from Redis
  const redis = getRedis()
  const raw = await redis.get<string>(`pending:${pending_id}`)

  if (!raw) {
    return c.json({ code: 'EXPIRED', message: 'Registration expired or invalid. Please start again.' }, 400)
  }

  const pending: PendingRegistration = typeof raw === 'string' ? JSON.parse(raw) : raw

  // Register the verify attempt BEFORE calling Supabase. The 5-attempt cap
  // burns the pending key on overflow so an attacker can't keep probing the
  // 6-digit code space. Supabase itself has no per-pending_id counter.
  try {
    await registerOtpVerifyAttempt(pending_id, 'pending:')
  } catch (e) {
    if (e instanceof OtpRateError) {
      if (e.retryAfterSeconds) c.header('Retry-After', String(e.retryAfterSeconds))
      return c.json({ code: e.code, message: e.message }, 429)
    }
    throw e
  }

  // Verify OTP via Supabase Auth
  const supabase = getSupabaseClient()
  const { error: verifyError } = await supabase.auth.verifyOtp({
    email: pending.email,
    token: code,
    type: 'email',
  })

  if (verifyError) {
    return c.json({ code: 'INVALID_CODE', message: 'Invalid or expired verification code' }, 400)
  }

  // Delete pending IMMEDIATELY after OTP verification to prevent replay.
  // If anything below fails, the user starts over (safe — no agent was created).
  await redis.del(`pending:${pending_id}`)
  await clearOtpAttempts(pending_id)

  // Create agent — the DB UNIQUE constraints on handle and email are the final
  // safety net against race conditions. If two verify calls race past the OTP check,
  // one will succeed and the other hits a constraint violation → clean 409.
  const agentId = generateId('agt')
  const apiKey = `ac_${randomBytes(32).toString('base64url')}`
  const apiKeyHash = createHash('sha256').update(apiKey).digest('hex')

  try {
    const agent = await insertAgent({
      id: agentId,
      handle: pending.handle,
      email: pending.email,
      api_key_hash: apiKeyHash,
      display_name: pending.display_name,
      description: pending.description,
    })

    // Fire agent.created to the platform-support channel. Only subscribers
    // whose agent row is is_system can register for this event (enforced in
    // webhook.service), so the enqueue only produces rows when chatfather
    // (or another future system agent) has a live webhook — zero overhead
    // in pre-chatfather environments and no duplicate-delivery risk.
    //
    // Fire-and-forget: a failure to enqueue must NOT bounce the registration
    // back to the user. Their account is real; the welcome DM is best-effort.
    // The webhook.service logs enqueue failures per row, so observability
    // isn't lost.
    fireWebhooks(CHATFATHER_AGENT_ID, 'agent.created', {
      handle: agent.handle,
      display_name: agent.display_name,
      created_at: agent.created_at,
    }).catch((err) => {
      console.error('[register] fireWebhooks agent.created failed:', err)
    })

    // Return agent (without internal id or api_key_hash) + raw API key (shown once)
    const { api_key_hash: _, id: _id, ...safeAgent } = agent
    return c.json({ agent: safeAgent, api_key: apiKey }, 201)
  } catch (e: unknown) {
    // DB unique constraint violation — handle or email was taken between check and insert,
    // or the namespace-isolation trigger rejected an email that also belongs to an owner.
    // The trigger raises with a message starting with 'EMAIL_IS_OWNER:' using errcode
    // unique_violation, so we detect that prefix first and short-circuit before the
    // generic email-taken fallback.
    const msg = e instanceof Error ? e.message : ''
    if (msg.includes('EMAIL_IS_OWNER')) {
      return c.json({ code: 'EMAIL_IS_OWNER', message: 'This email is registered for the owner dashboard. Use a different email for the agent account.' }, 409)
    }
    if (msg.includes('unique') || msg.includes('duplicate') || msg.includes('agents_email_unique') || msg.includes('agents_handle_key')) {
      if (msg.includes('email')) {
        return c.json({ code: 'EMAIL_TAKEN', message: 'An account was already registered with this email' }, 409)
      }
      return c.json({ code: 'HANDLE_TAKEN', message: `Handle @${pending.handle} is already taken` }, 409)
    }
    throw e
  }
})

export { register as registerRoutes }
