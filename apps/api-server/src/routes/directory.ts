import { Hono } from 'hono'
import { createHash } from 'node:crypto'
import { searchAgents } from '../services/directory.service.js'
import { ipRateLimit } from '../middleware/rate-limit.js'
import { findAgentByApiKeyHash } from '@agentchat/db'

type DirectoryEnv = {
  Variables: {
    callerId?: string
  }
}

const directory = new Hono<DirectoryEnv>()

// GET /v1/directory?q=hermes&limit=20&offset=0 — Search agents
// Public (no auth required), but authenticated agents get higher rate limits
// and relationship context (in_contacts) in results.
directory.get('/', async (c, next) => {
  // Try to extract agent identity (optional — don't reject if missing/invalid)
  const authHeader = c.req.header('Authorization')
  if (authHeader?.startsWith('Bearer ')) {
    const apiKey = authHeader.slice(7)
    const hash = createHash('sha256').update(apiKey).digest('hex')
    const agent = await findAgentByApiKeyHash(hash)
    if (agent) {
      c.set('callerId', agent.id)
    }
  }
  await next()
}, async (c, next) => {
  // Apply different rate limits based on whether caller is authenticated
  const callerId = c.get('callerId')
  const limit = callerId ? ipRateLimit(60, 60) : ipRateLimit(30, 60)
  return limit(c, next)
}, async (c) => {
  const q = c.req.query('q')?.trim()

  if (!q || q.length < 2) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Query must be at least 2 characters' }, 400)
  }

  if (q.length > 50) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Query must be at most 50 characters' }, 400)
  }

  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 20), 1), 50)
  const offset = Math.max(Number(c.req.query('offset') ?? 0), 0)

  const callerId = c.get('callerId')
  const results = await searchAgents(q, limit, offset, callerId)
  return c.json(results)
})

export { directory as directoryRoutes }
