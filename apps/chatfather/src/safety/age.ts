import { getRedis } from '../lib/redis.js'
import { logger } from '../lib/logger.js'
import { getSupabase } from '../lib/supabase.js'

// ─── Age gate ──────────────────────────────────────────────────────────────
//
// "Is this agent less than 24h old?" Used by the daily-cap check to give
// brand-new accounts a tighter limit (10 vs 50) — a spam wave typically
// comes from accounts spun up in the last few hours, not from
// established agents.
//
// Optimized for the common case: a recurring sender. Without a cache we
// hit Supabase on every inbound message; with a cache we hit it roughly
// once per sender per day.
//
// Cache shape:
//   Key  : cf:age:<handle>
//   Value: 'new' | 'old'
//   TTL  : 5 min when 'new' (since the status flips to 'old' at 24h,
//          a 5-min window bounds the error to acceptable levels)
//          24h when 'old' (once old, stays old)
//
// Fail mode: if Supabase or Redis errors, we treat the agent as 'old'
// (the more permissive state). Reason: the age gate exists to TIGHTEN
// the daily cap, not to be a primary security barrier. Flipping to
// 'new' on transient errors would lock legitimate established agents
// to the 10/day floor. The 50/day cap still enforces a ceiling for
// everyone.

export async function isNewAgent(handle: string): Promise<boolean> {
  const redis = getRedis()
  const cacheKey = `cf:age:${handle}`

  try {
    const cached = await redis.get<string>(cacheKey)
    if (cached === 'new') return true
    if (cached === 'old') return false
  } catch (err) {
    // Redis blip — fall through to DB. Don't fail-open here because
    // we'd rather pay the DB round trip than mis-classify an agent.
    logger.warn({ err, handle }, 'age_cache_read_failed')
  }

  const sb = getSupabase()
  const { data, error } = await sb
    .from('agents')
    .select('created_at')
    .eq('handle', handle)
    .maybeSingle()

  if (error) {
    logger.error({ err: error, handle }, 'age_lookup_failed')
    return false // treat as 'old' on error — see the comment above
  }
  if (!data) {
    // Agent handle not found. Shouldn't happen for a message.new
    // webhook (the sender exists by construction) but if it ever
    // does, default to 'old' to avoid over-tightening.
    logger.warn({ handle }, 'age_handle_not_found')
    return false
  }

  const createdAtMs = new Date(data.created_at as string).getTime()
  const ageMs = Date.now() - createdAtMs
  const isNew = ageMs < 24 * 3600 * 1000

  // Populate cache. TTLs chosen so 'new' is recomputed often enough to
  // flip to 'old' around the 24h mark; 'old' is cheap to keep for longer.
  try {
    await redis.set(cacheKey, isNew ? 'new' : 'old', {
      ex: isNew ? 300 : 24 * 3600,
    })
  } catch (err) {
    // Cache-write failure is harmless — we just pay the DB again.
    logger.warn({ err, handle }, 'age_cache_write_failed')
  }

  return isNew
}
