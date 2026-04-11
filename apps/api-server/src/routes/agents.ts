import { Hono } from 'hono'
import { UpdateAgentRequest, VerifyRequest } from '@agentchat/shared'
import { authMiddleware } from '../middleware/auth.js'
import { getAgent, updateAgent, deleteAgent, rotateApiKey, AgentError } from '../services/agent.service.js'
import { getSupabaseClient, findAgentById, findAgentByEmail } from '@agentchat/db'
import { getRedis } from '../lib/redis.js'
import { generateId } from '../lib/id.js'
import { ipRateLimit } from '../middleware/rate-limit.js'

const agents = new Hono()

// ─── Account Recovery (no API key needed — email-only) ─────────────────────
// These MUST be registered before /:id routes to avoid "recover" matching as a param.
// Fixes the lockout scenario: if an agent loses its API key (network drop during
// rotation, lost credentials), this endpoint recovers access via email OTP.

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
  const agent = await findAgentByEmail(normalizedEmail)

  // Always return success message (don't leak whether email exists)
  const genericMsg = 'If an agent is registered with this email, a verification code has been sent.'

  if (!agent || agent.status === 'deleted') {
    return c.json({ message: genericMsg })
  }

  // Store pending recovery in Redis BEFORE sending OTP
  const pendingId = generateId('pnd')
  const redis = getRedis()
  await redis.set(`recover:${pendingId}`, JSON.stringify({ agent_id: agent.id, email: normalizedEmail }), { ex: 600 })

  const supabase = getSupabaseClient()
  const { error } = await supabase.auth.signInWithOtp({ email: normalizedEmail })

  if (error) {
    await redis.del(`recover:${pendingId}`).catch(() => {})
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

// ─── Public profile ────────────────────────────────────────────────────────

// GET /v1/agents/:id — Get agent profile (public, no auth)
agents.get('/:id', async (c) => {
  const id = c.req.param('id')
  try {
    const agent = await getAgent(id)
    return c.json(agent)
  } catch (e) {
    if (e instanceof AgentError) {
      return c.json({ code: e.code, message: e.message }, e.status as 404)
    }
    throw e
  }
})

// ─── Self-management (agent auth via API key) ──────────────────────────────

// PATCH /v1/agents/:id — Update own profile
agents.patch('/:id', authMiddleware, async (c) => {
  const id = c.req.param('id')
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
    const agentId = c.get('agentId')
    const agent = await updateAgent(id, parsed.data, agentId)
    return c.json(agent)
  } catch (e) {
    if (e instanceof AgentError) {
      return c.json({ code: e.code, message: e.message }, e.status as 400 | 403 | 404)
    }
    throw e
  }
})

// DELETE /v1/agents/:id — Delete own agent (soft delete)
agents.delete('/:id', authMiddleware, async (c) => {
  const id = c.req.param('id')
  try {
    const agentId = c.get('agentId')
    await deleteAgent(id, agentId)
    return c.json({ message: 'Agent deleted' })
  } catch (e) {
    if (e instanceof AgentError) {
      return c.json({ code: e.code, message: e.message }, e.status as 403 | 404)
    }
    throw e
  }
})

// ─── API Key Rotation (two-step OTP, requires current API key) ─────────────

// POST /v1/agents/:id/rotate-key — Step 1: Send OTP
agents.post('/:id/rotate-key', authMiddleware, ipRateLimit(3, 3600), async (c) => {
  const id = c.req.param('id')
  const agentId = c.get('agentId')

  if (id !== agentId) {
    return c.json({ code: 'FORBIDDEN', message: 'You can only rotate your own API key' }, 403)
  }

  const agent = await findAgentById(id)
  if (!agent || agent.status === 'deleted') {
    return c.json({ code: 'AGENT_NOT_FOUND', message: 'Agent not found' }, 404)
  }

  // Store pending rotation in Redis BEFORE sending OTP
  const pendingId = generateId('pnd')
  const redis = getRedis()
  await redis.set(`rotate:${pendingId}`, JSON.stringify({ agent_id: id, email: agent.email }), { ex: 600 })

  const supabase = getSupabaseClient()
  const { error } = await supabase.auth.signInWithOtp({ email: agent.email })

  if (error) {
    await redis.del(`rotate:${pendingId}`).catch(() => {})
    return c.json({ code: 'OTP_FAILED', message: 'Failed to send verification code' }, 500)
  }

  return c.json({ pending_id: pendingId, message: 'Verification code sent to registered email' })
})

// POST /v1/agents/:id/rotate-key/verify — Step 2: Verify OTP and rotate
agents.post('/:id/rotate-key/verify', authMiddleware, async (c) => {
  const id = c.req.param('id')
  const agentId = c.get('agentId')

  if (id !== agentId) {
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

  if (pending.agent_id !== id) {
    return c.json({ code: 'FORBIDDEN', message: 'Invalid rotation request' }, 403)
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

  try {
    const result = await rotateApiKey(id, agentId)
    return c.json(result)
  } catch (e) {
    if (e instanceof AgentError) {
      return c.json({ code: e.code, message: e.message }, e.status as 403 | 404)
    }
    throw e
  }
})

export { agents as agentRoutes }
