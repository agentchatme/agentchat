import { createMiddleware } from 'hono/factory'
import { getRedis } from '../lib/redis.js'

/**
 * IP-based rate limiter for auth endpoints.
 * @param maxRequests  Max requests allowed in the window
 * @param windowSecs   Window duration in seconds
 */
export function ipRateLimit(maxRequests: number, windowSecs: number) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createMiddleware(async (c, next): Promise<any> => {
    const ip =
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
      c.req.header('x-real-ip') ??
      'unknown'

    const key = `rl:ip:${ip}:${c.req.path}:${Math.floor(Date.now() / (windowSecs * 1000))}`

    try {
      const redis = getRedis()
      const current = await redis.incr(key)
      if (current === 1) {
        await redis.expire(key, windowSecs + 1)
      }

      if (current > maxRequests) {
        return c.json(
          { code: 'RATE_LIMITED', message: `Too many requests. Try again in ${windowSecs} seconds.` },
          429,
        )
      }
    } catch {
      // Redis down — fail open so auth still works
    }

    await next()
  })
}

/**
 * Per-key rate limiter for arbitrary identifiers (e.g., email, agent_id).
 * Used alongside ipRateLimit to enforce per-subject caps on OTP requests, etc.
 */
export function keyRateLimit(
  keyPrefix: string,
  maxRequests: number,
  windowSecs: number,
  keyFn: (c: Parameters<Parameters<typeof createMiddleware>[0]>[0]) => Promise<string | null> | string | null,
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createMiddleware(async (c, next): Promise<any> => {
    const subject = await keyFn(c)
    if (!subject) {
      await next()
      return
    }

    const key = `rl:${keyPrefix}:${subject}:${Math.floor(Date.now() / (windowSecs * 1000))}`

    try {
      const redis = getRedis()
      const current = await redis.incr(key)
      if (current === 1) {
        await redis.expire(key, windowSecs + 1)
      }

      if (current > maxRequests) {
        return c.json(
          { code: 'RATE_LIMITED', message: `Too many requests. Try again in ${windowSecs} seconds.` },
          429,
        )
      }
    } catch {
      // Redis down — fail open
    }

    await next()
  })
}
