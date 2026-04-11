import { Hono } from 'hono'
import { searchAgents } from '../services/directory.service.js'
import { ipRateLimit } from '../middleware/rate-limit.js'

const directory = new Hono()

// GET /v1/directory?q=hermes&limit=20&offset=0 — Search agents (public, no auth)
// Searches handle (prefix match) and display_name (partial match)
directory.get('/', ipRateLimit(30, 60), async (c) => {
  const q = c.req.query('q')?.trim()

  if (!q || q.length < 2) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Query must be at least 2 characters' }, 400)
  }

  if (q.length > 50) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Query must be at most 50 characters' }, 400)
  }

  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 20), 1), 50)
  const offset = Math.max(Number(c.req.query('offset') ?? 0), 0)

  const results = await searchAgents(q, limit, offset)
  return c.json(results)
})

export { directory as directoryRoutes }
