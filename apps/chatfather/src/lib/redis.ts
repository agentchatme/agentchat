import { Redis } from '@upstash/redis'
import { env } from '../env.js'

// Shared Upstash client. Same pattern as api-server/src/lib/redis.ts —
// lazy-init on first access so the process doesn't fail to boot when
// Redis is unreachable (most rate-limit paths fail open; webhook
// idempotency is the one place that fails closed — see webhook.ts).
let redis: Redis | null = null

export function getRedis(): Redis {
  if (!redis) {
    redis = new Redis({
      url: env.UPSTASH_REDIS_REST_URL,
      token: env.UPSTASH_REDIS_REST_TOKEN,
    })
  }
  return redis
}
