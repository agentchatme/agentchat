import { getRedis } from '../lib/redis.js'
import { logger } from '../lib/logger.js'

// ─── Global LLM budget ─────────────────────────────────────────────────────
//
// Fleet-wide (all chatfather machines share one Redis counter) cap on
// OpenRouter tokens consumed per UTC day. When the counter crosses the
// cap, the LLM path stops calling OpenRouter and replies with a static
// "temporarily unavailable" message. The fast-path still works — a
// user who asks a FAQ question while the budget is exceeded gets the
// FAQ answer as normal.
//
// Cap tuning:
//   BUDGET_TOKENS_PER_DAY = 5,000,000 ≈ $50/day at Kimi K2's blended
//   pricing snapshot (~$0.15/M input, ~$2.50/M output, roughly 50/50
//   mix for our short prompts and short replies). DeepSeek fallback
//   is cheaper per token so an exclusively-fallback day lands under
//   budget even closer to the 5M mark.
//
// The counter is ADVISORY — we check it BEFORE calling, and record AFTER.
// A slight over-spend can happen if many concurrent calls pass the check
// and THEN record. Fine: the sloppy accounting costs at most ~1 minute
// of over-budget burn before the check re-gates. Exact accounting would
// need a Lua script reservation and isn't worth the complexity for a
// daily budget.

const BUDGET_TOKENS_PER_DAY = 5_000_000

function bucketKey(): string {
  return `cf:budget:${new Date().toISOString().slice(0, 10)}`
}

/**
 * Check if we're under the daily token budget. Returns `allowed: true`
 * if chatfather can make an LLM call now, `false` if the budget is
 * spent. On Redis failure we fail OPEN — the budget is a cost-
 * management guardrail, not a security control, and locking out
 * support during a transient Upstash blip is a worse user experience
 * than slightly overrunning for a few minutes.
 */
export async function checkLlmBudget(): Promise<{
  allowed: boolean
  used: number
  cap: number
}> {
  const redis = getRedis()
  try {
    const raw = await redis.get<number | string>(bucketKey())
    const used = typeof raw === 'number' ? raw : raw ? Number(raw) : 0
    return {
      allowed: used < BUDGET_TOKENS_PER_DAY,
      used,
      cap: BUDGET_TOKENS_PER_DAY,
    }
  } catch (err) {
    logger.error({ err }, 'budget_check_redis_error_fail_open')
    return { allowed: true, used: 0, cap: BUDGET_TOKENS_PER_DAY }
  }
}

/**
 * Record token usage from a completed LLM call. Adds to the daily
 * counter and extends the TTL so the key survives to the end of day
 * even if the first call of the day hit a Redis hiccup.
 */
export async function recordLlmUsage(totalTokens: number): Promise<void> {
  if (totalTokens <= 0) return
  const redis = getRedis()
  const key = bucketKey()
  try {
    await redis.incrby(key, totalTokens)
    await redis.expire(key, 25 * 3600)
  } catch (err) {
    // Missing usage data is recoverable — the next check will still
    // reflect prior calls that DID record. Log and move on.
    logger.warn({ err, tokens: totalTokens }, 'budget_record_failed')
  }
}

export const BUDGET_EXCEEDED_NOTICE = `I'm temporarily at my daily research limit, so I can't look that up right now. Try one of the topics I know off the top of my head: \`getting started\`, \`api key\`, \`pricing\`, \`rate limits\`, \`webhooks\`, \`suspended\`, \`delete account\`. Or \`/report other <description>\` to reach a human.`
