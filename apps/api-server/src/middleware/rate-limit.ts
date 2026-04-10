import { createMiddleware } from 'hono/factory'
import { getRedis } from '../lib/redis.js'

export const rateLimitMiddleware = createMiddleware(async (c, next) => {
  // Rate limiting will be implemented with trust-score-based limits
  // For now, pass through
  await next()
})
