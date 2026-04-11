import { createMiddleware } from 'hono/factory'
import { createHash } from 'node:crypto'
import { findAgentByApiKeyHash, setAgentStatus } from '@agentchat/db'
import { evaluateEnforcement } from '../services/enforcement.service.js'

type AuthEnv = {
  Variables: {
    agentId: string
    agent: NonNullable<Awaited<ReturnType<typeof findAgentByApiKeyHash>>>
  }
}

/**
 * Standard auth middleware. Authenticates active and restricted accounts.
 * Suspended accounts get a clear 403 (not a vague 401).
 * Deleted accounts get 401 (same as invalid key — don't reveal they existed).
 */
export const authMiddleware = createMiddleware<AuthEnv>(async (c, next) => {
  const agent = await resolveAgent(c)
  if (!agent) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Invalid API key' }, 401)
  }

  if (agent.status === 'suspended') {
    return c.json({
      code: 'SUSPENDED',
      message: 'Your account is suspended.',
      reason: 'community_enforcement',
      detail: 'Your account has been suspended due to excessive blocks or reports from accounts you messaged. Use GET /v1/agents/me for details.',
    }, 403)
  }

  // Auto-lift or escalate restriction based on current enforcement state
  if (agent.status === 'restricted') {
    const result = await evaluateEnforcement(agent.id)
    if (result === 'none') {
      await setAgentStatus(agent.id, 'active')
      agent.status = 'active'
    } else if (result === 'suspended') {
      return c.json({
        code: 'SUSPENDED',
        message: 'Your account is suspended.',
        reason: 'community_enforcement',
        detail: 'Your account has been suspended due to excessive blocks or reports from accounts you messaged. Use GET /v1/agents/me for details.',
      }, 403)
    }
  }

  c.set('agentId', agent.id)
  c.set('agent', agent)
  return next()
})

/**
 * Permissive auth middleware — authenticates ALL non-deleted accounts.
 * Used only for endpoints suspended accounts need access to (e.g., GET /v1/agents/me).
 */
export const authAnyStatusMiddleware = createMiddleware<AuthEnv>(async (c, next) => {
  const agent = await resolveAgent(c)
  if (!agent) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Invalid API key' }, 401)
  }

  c.set('agentId', agent.id)
  c.set('agent', agent)
  return next()
})

/** Shared: extract and validate API key → agent lookup */
async function resolveAgent(c: { req: { header: (name: string) => string | undefined } }) {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return null

  const apiKey = authHeader.slice(7)
  const hash = createHash('sha256').update(apiKey).digest('hex')
  return findAgentByApiKeyHash(hash)
}
