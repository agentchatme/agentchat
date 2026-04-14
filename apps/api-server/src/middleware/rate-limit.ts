import { createMiddleware } from 'hono/factory'
import { getRedis } from '../lib/redis.js'

// Resolve the real client IP from upstream proxy headers. Order matters
// because most proxies APPEND to X-Forwarded-For rather than replacing
// it — a client that sends `X-Forwarded-For: 1.2.3.4` would have the
// edge produce `X-Forwarded-For: 1.2.3.4, <real-ip>` and the leftmost
// entry (which we'd otherwise read) is fully attacker-controlled.
//
// Trusted, edge-set headers we read first:
//   1. Fly-Client-IP — Fly.io's edge always sets this; the client cannot
//      send it because Fly strips it on inbound. This is what we want
//      whenever the API runs behind Fly (per fly.toml).
//   2. CF-Connecting-IP — Cloudflare equivalent, future-proofing for any
//      CDN we might put in front later.
// Only if neither is present do we fall back to X-Forwarded-For, and we
// take the RIGHTMOST entry (the closest hop to us, presumably the trusted
// proxy). Final fallback is x-real-ip, then 'unknown'.
function resolveClientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  const flyIp = c.req.header('fly-client-ip')
  if (flyIp) return flyIp
  const cfIp = c.req.header('cf-connecting-ip')
  if (cfIp) return cfIp
  const xff = c.req.header('x-forwarded-for')
  if (xff) {
    const parts = xff.split(',').map((p) => p.trim()).filter(Boolean)
    const last = parts[parts.length - 1]
    if (last) return last
  }
  return c.req.header('x-real-ip') ?? 'unknown'
}

/**
 * IP-based rate limiter for auth endpoints.
 * @param maxRequests  Max requests allowed in the window
 * @param windowSecs   Window duration in seconds
 */
export function ipRateLimit(maxRequests: number, windowSecs: number) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createMiddleware(async (c, next): Promise<any> => {
    const ip = resolveClientIp(c)

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
