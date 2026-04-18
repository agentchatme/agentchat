import { getRedis } from '../lib/redis.js'
import { logger } from '../lib/logger.js'

// ─── Per-sender rate limits ────────────────────────────────────────────────
//
// Two independent gates a message must pass, in this order:
//
//   BURST  — up to 5 messages in any 30s window. Protects against a
//            tight loop (script bug, retry hammer, stuck UI) from a
//            single sender. Exceeding this is silent — no reply. If
//            the sender is a human typo, they'll try again in a few
//            seconds and succeed. If the sender is a runaway script,
//            we never give it a signal to retry off.
//
//   DAILY  — up to 50 messages per UTC day (10 if the agent was
//            created less than 24h ago — age-gate). Exceeding this
//            sends a ONE-TIME polite notice per day so the user
//            knows they were throttled, not ghosted. Subsequent
//            messages from the same agent in the same day are
//            silent-dropped so we don't burn the SDK's send rate
//            telling them the same thing 40 more times.
//
// Both counters are fixed-window in Redis (INCR + EXPIRE). A sliding
// window would be more accurate at the boundary, but: this is a
// SUPPORT bot's inbound filter, not a financial rate limit. The
// edge-case "user sends 10 in the last second of one window and 10
// in the first second of the next" is fine — 20 support messages in
// 2 seconds from one agent is still well under the daily cap and the
// burst window stops them anyway.

const BURST_WINDOW_SECONDS = 30
const BURST_CAP = 5

const DAILY_CAP_ESTABLISHED = 50
const DAILY_CAP_NEW_AGENT = 10

/**
 * Returns `allowed: true` if the sender is inside the burst window's
 * cap. Mutates Redis state (increments counter) as a side-effect, so
 * every call counts against the window — callers must only invoke
 * this once per incoming message.
 */
export async function checkBurstRate(handle: string): Promise<{
  allowed: boolean
  current: number
  cap: number
}> {
  const redis = getRedis()
  const key = `cf:rate:burst:${handle}`
  try {
    const count = await redis.incr(key)
    if (count === 1) {
      // First hit — set the window TTL. If this EXPIRE call fails
      // (unlikely), the key would stick around forever; we accept that
      // risk since Upstash's memory is multi-GB and chatfather's
      // active-sender set is small.
      await redis.expire(key, BURST_WINDOW_SECONDS)
    }
    return { allowed: count <= BURST_CAP, current: count, cap: BURST_CAP }
  } catch (err) {
    // Redis blip — fail OPEN on burst rate limiting. The daily cap
    // still runs downstream, so a stuck Upstash doesn't become a
    // spam amplifier. (Webhook idempotency fails closed for the
    // opposite reason — see webhook.ts.)
    logger.error({ err, handle }, 'rate_burst_redis_error_fail_open')
    return { allowed: true, current: 0, cap: BURST_CAP }
  }
}

/**
 * Returns `{ allowed, firstOverflow }`. `firstOverflow` is true iff
 * this call is the one that crossed the cap — the caller uses it to
 * decide whether to send the one-time-per-day "you're throttled" DM.
 */
export async function checkDailyCap(
  handle: string,
  isNewAgent: boolean,
): Promise<{
  allowed: boolean
  firstOverflow: boolean
  current: number
  cap: number
}> {
  const cap = isNewAgent ? DAILY_CAP_NEW_AGENT : DAILY_CAP_ESTABLISHED
  const ymd = new Date().toISOString().slice(0, 10)
  const redis = getRedis()
  const key = `cf:rate:daily:${handle}:${ymd}`
  try {
    const count = await redis.incr(key)
    if (count === 1) {
      // 25h TTL gives a buffer for UTC boundary fuzziness. The date
      // prefix in the key ensures no cross-day leakage anyway, but the
      // TTL keeps Redis tidy.
      await redis.expire(key, 25 * 3600)
    }
    return {
      allowed: count <= cap,
      firstOverflow: count === cap + 1,
      current: count,
      cap,
    }
  } catch (err) {
    logger.error({ err, handle }, 'rate_daily_redis_error_fail_open')
    return { allowed: true, firstOverflow: false, current: 0, cap }
  }
}

export const DAILY_CAP_NOTICE = `You've hit today's support message limit. I'll be back fresh tomorrow (the counter resets at 00:00 UTC). If it's urgent, reply with a \`/report <bug|feature|abuse|other> <description>\` and a human will pick it up.`
