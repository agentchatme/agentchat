import { getRedis } from '../lib/redis.js'

/**
 * Per-webhook circuit breaker (§3.4.3).
 *
 * Scoped per webhook endpoint (not per agent): one agent may own several
 * webhooks and a single broken one must not mute the others.
 *
 * State machine:
 *   closed → open     : 5 consecutive failures, OR 10 failures within 60s
 *   open → half_open  : 5 min cooldown elapsed (next claim allowed as probe)
 *   half_open → closed: probe returns 2xx
 *   half_open → open  : probe fails; cooldown resets
 *
 * Storage:
 *   wh:cb:{id}   — Redis hash: state, fail_count (consecutive), window_start,
 *                  window_fails (sliding 60s), opened_at
 *   wh:cb:open   — Redis SET of webhook ids currently OPEN or HALF_OPEN. Used
 *                  to build the `exclude_webhook_ids` list passed into
 *                  claim_webhook_deliveries — rows for excluded webhooks
 *                  stay 'pending' and the attempt counter is not consumed,
 *                  so the ~31h retry horizon (§3.4.1) is preserved
 *                  end-to-end through circuit-breaker skips.
 *
 * Fail-open: any Redis error treats every circuit as closed. Matches the
 * §3.3 rate-limit precedent — better to deliver than silently freeze.
 * Transient Redis outages briefly disable the breaker; circuits reopen
 * naturally on the next failure after Redis recovers.
 */

const OPEN_SET = 'wh:cb:open'
const CONSECUTIVE_THRESHOLD = 5
const WINDOW_THRESHOLD = 10
const WINDOW_SECONDS = 60
const COOLDOWN_SECONDS = 5 * 60

// Evaluate the OPEN set, promote expired circuits to HALF_OPEN, and return
// the webhook ids that are still excluded from claim. Run as a single Lua
// script so the promotion+enumeration is atomic — no window where a
// competing worker could see the same webhook as both "ready to probe"
// and "still open".
const EVAL_OPEN_SET = `
local set_key = KEYS[1]
local now = tonumber(ARGV[1])
local cooldown = tonumber(ARGV[2])
local result = {}

local members = redis.call('SMEMBERS', set_key)
for _, id in ipairs(members) do
  local hash = 'wh:cb:' .. id
  local state = redis.call('HGET', hash, 'state')
  if state == 'open' then
    local opened_at = tonumber(redis.call('HGET', hash, 'opened_at')) or now
    if now - opened_at >= cooldown then
      -- Promote to half_open and drop from the exclude set so the next
      -- claim can pull exactly one probe row for this webhook.
      redis.call('HSET', hash, 'state', 'half_open')
      redis.call('SREM', set_key, id)
    else
      table.insert(result, id)
    end
  elseif state == 'half_open' then
    -- A probe is currently in flight (or its recordResult is pending).
    -- Keep excluded so parallel workers don't stack probes.
    table.insert(result, id)
  else
    -- state is 'closed' or nil — stale set member, clean up.
    redis.call('SREM', set_key, id)
  end
end

return result
`

// Record a failure and transition state atomically. Returns the new state
// string so the caller can count state-change transitions for metrics.
const EVAL_RECORD_FAILURE = `
local hash = KEYS[1]
local set_key = KEYS[2]
local id = ARGV[1]
local now = tonumber(ARGV[2])
local consecutive_threshold = tonumber(ARGV[3])
local window_threshold = tonumber(ARGV[4])
local window_seconds = tonumber(ARGV[5])

local state = redis.call('HGET', hash, 'state') or 'closed'

if state == 'half_open' then
  -- Probe failed: back to open, reset cooldown. PERSIST strips any TTL
  -- inherited from the closed-state EXPIRE below so the 5 min cooldown
  -- can't be cut short by a 120s self-destruct timer.
  redis.call('HSET', hash, 'state', 'open', 'opened_at', now)
  redis.call('PERSIST', hash)
  redis.call('SADD', set_key, id)
  return 'open'
end

if state == 'open' then
  -- A failure while already open: re-stamp opened_at so cooldown restarts
  -- from the latest failure. Prevents a borderline-recovering endpoint
  -- from flipping to half_open on the heels of a just-failed probe.
  -- PERSIST for the same reason as the half_open branch.
  redis.call('HSET', hash, 'opened_at', now)
  redis.call('PERSIST', hash)
  redis.call('SADD', set_key, id)
  return 'open'
end

-- state == 'closed'
local fail_count = tonumber(redis.call('HGET', hash, 'fail_count')) or 0
fail_count = fail_count + 1

local window_start = tonumber(redis.call('HGET', hash, 'window_start')) or 0
local window_fails = tonumber(redis.call('HGET', hash, 'window_fails')) or 0

if now - window_start > window_seconds then
  window_start = now
  window_fails = 1
else
  window_fails = window_fails + 1
end

if fail_count >= consecutive_threshold or window_fails >= window_threshold then
  redis.call('HSET', hash,
    'state', 'open',
    'fail_count', 0,
    'window_start', 0,
    'window_fails', 0,
    'opened_at', now
  )
  -- CRITICAL: strip the TTL set by earlier closed-state failures below.
  -- HSET preserves TTL; without PERSIST the hash would self-destruct
  -- window_seconds*2 after the last pre-threshold failure (often ~120s),
  -- long before the 5 min cooldown elapses. The hash disappearing looks
  -- to EVAL_OPEN_SET like state==nil → circuit silently self-heals.
  redis.call('PERSIST', hash)
  redis.call('SADD', set_key, id)
  return 'open'
end

redis.call('HSET', hash,
  'fail_count', fail_count,
  'window_start', window_start,
  'window_fails', window_fails
)
-- Expire the closed-state bookkeeping after 2× window so stale counters
-- from long-quiet webhooks don't accumulate forever.
redis.call('EXPIRE', hash, window_seconds * 2)
return 'closed'
`

// Record a success and clear state. Used whether we were previously closed
// with non-zero fail_count or half_open — either way the webhook is now
// healthy. No return value needed; caller only cares on failure.
const EVAL_RECORD_SUCCESS = `
local hash = KEYS[1]
local set_key = KEYS[2]
local id = ARGV[1]

redis.call('DEL', hash)
redis.call('SREM', set_key, id)
return 1
`

/**
 * Return the webhook ids currently blocked by an open circuit. Empty array
 * if Redis is unreachable (fail-open) so the worker delivers normally in
 * degraded modes.
 */
export async function getOpenWebhookIds(): Promise<string[]> {
  try {
    const redis = getRedis()
    const now = Math.floor(Date.now() / 1000)
    const result = (await redis.eval(
      EVAL_OPEN_SET,
      [OPEN_SET],
      [now, COOLDOWN_SECONDS],
    )) as string[] | null
    return Array.isArray(result) ? result : []
  } catch {
    // Fail-open: matches the §3.3 rate-limit pattern. Better to deliver
    // than silently freeze when Redis is unreachable.
    return []
  }
}

/**
 * Record a failed delivery attempt against the webhook. Transitions the
 * circuit if thresholds are crossed. Best-effort — any Redis error is
 * swallowed so a transient outage can't crash the worker.
 */
export async function recordWebhookFailure(webhookId: string): Promise<void> {
  try {
    const redis = getRedis()
    const now = Math.floor(Date.now() / 1000)
    await redis.eval(
      EVAL_RECORD_FAILURE,
      [`wh:cb:${webhookId}`, OPEN_SET],
      [
        webhookId,
        now,
        CONSECUTIVE_THRESHOLD,
        WINDOW_THRESHOLD,
        WINDOW_SECONDS,
      ],
    )
  } catch {
    // Swallow — breaker is a best-effort guardrail.
  }
}

/**
 * Record a successful delivery attempt. Clears all state for the webhook
 * and removes it from the exclude set. Called after every 2xx response.
 */
export async function recordWebhookSuccess(webhookId: string): Promise<void> {
  try {
    const redis = getRedis()
    await redis.eval(
      EVAL_RECORD_SUCCESS,
      [`wh:cb:${webhookId}`, OPEN_SET],
      [webhookId],
    )
  } catch {
    // Swallow — a stale open entry will self-heal on the next
    // getOpenWebhookIds evaluation once state goes back to closed/absent.
  }
}

// Exported solely for tests; production code should use the functions above.
export const __TEST_ONLY__ = {
  OPEN_SET,
  CONSECUTIVE_THRESHOLD,
  WINDOW_THRESHOLD,
  WINDOW_SECONDS,
  COOLDOWN_SECONDS,
}
