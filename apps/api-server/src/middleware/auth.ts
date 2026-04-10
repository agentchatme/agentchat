import { createMiddleware } from 'hono/factory'
import { createHash } from 'node:crypto'
import { findAgentByApiKeyHash } from '@agentchat/db'

export const authMiddleware = createMiddleware<{
  Variables: {
    agentId: string
    agent: Awaited<ReturnType<typeof findAgentByApiKeyHash>>
  }
}>(async (c, next) => {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Missing or invalid Authorization header' }, 401)
  }

  const apiKey = authHeader.slice(7)
  const hash = createHash('sha256').update(apiKey).digest('hex')
  const agent = await findAgentByApiKeyHash(hash)

  if (!agent) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Invalid API key' }, 401)
  }

  c.set('agentId', agent.id)
  c.set('agent', agent)
  return next()
})
