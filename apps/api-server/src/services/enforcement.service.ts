import { countColdOutreaches, countInitiatedBlocks, countInitiatedReports, setAgentStatus } from '@agentchat/db'
import {
  COLD_OUTREACH_DAILY_CAP,
  ENFORCEMENT,
  GLOBAL_RATE_LIMIT_PER_SECOND,
  GROUP_AGGREGATE_RATE_LIMIT_PER_SECOND,
  GROUP_INVITES_PER_DAY,
} from '@agentchat/shared'
import { Sentry } from '../instrument.js'
import { getRedis } from '../lib/redis.js'
import { logger } from '../lib/logger.js'
import { publishDisconnect } from '../ws/pubsub.js'

// ─── Rule 1: Cold Outreach Cap ─────────────────────────────────────────────

/**
 * Check if agent can send a cold message (new conversation).
 * Uses rolling 24h window — not UTC midnight — to prevent gaming.
 */
export async function checkColdOutreachCap(agentId: string): Promise<{
  allowed: boolean
  current: number
  limit: number
}> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const current = await countColdOutreaches(agentId, since)
  return {
    allowed: current < COLD_OUTREACH_DAILY_CAP,
    current,
    limit: COLD_OUTREACH_DAILY_CAP,
  }
}

// ─── Rule 2: Community Enforcement ──────────────────────────────────────────

/**
 * Evaluate enforcement thresholds after a block or report.
 * Only counts blocks/reports where the target initiated the conversation.
 * Returns the action taken.
 */
export async function evaluateEnforcement(agentId: string): Promise<'none' | 'restricted' | 'suspended'> {
  // Check suspension thresholds first (more severe)
  const [blocks7d, reports7d] = await Promise.all([
    countInitiatedBlocks(agentId, 7),
    countInitiatedReports(agentId, 7),
  ])

  if (blocks7d >= ENFORCEMENT.SUSPEND_BLOCKS_7D || reports7d >= ENFORCEMENT.SUSPEND_REPORTS_7D) {
    await setAgentStatus(agentId, 'suspended')
    // Evict any live WS sessions across every server — a newly-suspended
    // agent must stop receiving events, not just stop being able to send.
    // Mirrors the eviction on key rotation and account deletion.
    publishDisconnect(agentId, 1008, 'Account suspended')
    return 'suspended'
  }

  // Check restriction threshold (less severe)
  const blocks24h = await countInitiatedBlocks(agentId, 1)
  if (blocks24h >= ENFORCEMENT.RESTRICT_BLOCKS_24H) {
    await setAgentStatus(agentId, 'restricted')
    return 'restricted'
  }

  return 'none'
}

// ─── Rule 3: Global Rate Limit ──────────────────────────────────────────────

/**
 * Per-second sliding window rate limit. Flat 60/sec for all agents.
 * On Redis failure, fails open (allows the message).
 */
export async function checkGlobalRateLimit(agentId: string): Promise<{
  allowed: boolean
  retryAfterMs?: number
}> {
  try {
    const redis = getRedis()
    const second = Math.floor(Date.now() / 1000)
    const key = `ratelimit:persec:${agentId}:${second}`

    const current = await redis.incr(key)
    if (current === 1) {
      await redis.expire(key, 3) // 3s TTL (current second + buffer)
    }

    if (current > GLOBAL_RATE_LIMIT_PER_SECOND) {
      const nowMs = Date.now()
      const nextSecondMs = (second + 1) * 1000
      return { allowed: false, retryAfterMs: nextSecondMs - nowMs }
    }

    return { allowed: true }
  } catch {
    // Redis down — fail open. Better to allow messages without rate limiting
    // than to block all messages because the rate limiter is unavailable.
    console.error('[rate-limit] Redis unavailable — failing open')
    return { allowed: true }
  }
}

// ─── Rule 3b: Per-group aggregate rate limit ────────────────────────────────

/**
 * Alerting thresholds for group-aggregate rate-limit hits.
 *
 * The Prometheus counter `agentchat_rate_limit_hits_total{rule="group_aggregate"}`
 * records every hit. A background Grafana/Alertmanager rule is the right long-
 * term home for threshold alerts, but we don't have Alertmanager running yet —
 * so this in-code Sentry fire-on-spike mirrors the pattern used for the pub/sub
 * disconnect alert in ws/pubsub.ts:280. It's process-local (3-machine fleet →
 * each machine has its own counter), which means the effective fleet-wide
 * threshold is roughly 3× whatever we set here — but the asymmetry is fine for
 * a floor on "something is very wrong in a specific group."
 *
 * Tuning:
 *   - Legit background rate should be ~0 hits/minute. Honest agents do not
 *     sustainably exceed 20/sec aggregate (the cap). Hitting the cap at all
 *     implies either an attack, a looped agent, or a misconfigured notification
 *     bridge.
 *   - 30 hits/minute on one machine = ~1 hit every 2 seconds sustained. That's
 *     well above any transient-burst scenario (a poll-style "everyone reply"
 *     that tips the cap for 1-2 seconds generates 1-3 hits, not 30).
 *   - Cooldown of 5 minutes between alerts prevents Sentry spam during a
 *     sustained attack — on-call gets one page, not 60.
 */
const GROUP_AGGREGATE_ALERT_THRESHOLD_PER_MIN = 30
const GROUP_AGGREGATE_ALERT_COOLDOWN_MS = 5 * 60 * 1000
const GROUP_AGGREGATE_ALERT_WINDOW_MS = 60 * 1000

let groupAggregateHitsInWindow = 0
let groupAggregateWindowStartedAt = Date.now()
let groupAggregateLastAlertAt = 0
let groupAggregateLastOffendingConvId: string | null = null

function recordGroupAggregateHit(conversationId: string): void {
  const now = Date.now()

  if (now - groupAggregateWindowStartedAt >= GROUP_AGGREGATE_ALERT_WINDOW_MS) {
    groupAggregateHitsInWindow = 0
    groupAggregateWindowStartedAt = now
  }

  groupAggregateHitsInWindow += 1
  groupAggregateLastOffendingConvId = conversationId

  const overThreshold = groupAggregateHitsInWindow > GROUP_AGGREGATE_ALERT_THRESHOLD_PER_MIN
  const outsideCooldown = now - groupAggregateLastAlertAt > GROUP_AGGREGATE_ALERT_COOLDOWN_MS

  if (overThreshold && outsideCooldown) {
    groupAggregateLastAlertAt = now
    Sentry.captureMessage('group_aggregate_rate_limit_spike', {
      level: 'warning',
      tags: { component: 'enforcement', rule: 'group_aggregate' },
      extra: {
        hits_in_last_minute: groupAggregateHitsInWindow,
        threshold_per_min: GROUP_AGGREGATE_ALERT_THRESHOLD_PER_MIN,
        most_recent_offender_conversation_id: groupAggregateLastOffendingConvId,
        cap_per_second: GROUP_AGGREGATE_RATE_LIMIT_PER_SECOND,
      },
    })
    logger.warn(
      {
        hits_in_last_minute: groupAggregateHitsInWindow,
        threshold_per_min: GROUP_AGGREGATE_ALERT_THRESHOLD_PER_MIN,
        most_recent_offender_conversation_id: groupAggregateLastOffendingConvId,
      },
      'group_aggregate_rate_limit_spike',
    )
  }
}

/**
 * Per-second sliding window on total sends INTO a group, across all members.
 *
 * Keyed on conversation_id — every member's send increments the SAME bucket.
 * First 20 messages into the group in a given second succeed regardless of
 * sender; the 21st bounces with 429 regardless of sender. Stacks alongside
 * the per-agent global 60/sec cap (a group send is counted against both).
 *
 * This is the only rate-limit layer that bounds coordinated K-sender abuse
 * in one room — per-agent buckets by definition can't see across accounts,
 * so without this a botnet of N colluders can sum to N × 60/sec aggregate
 * fan-out and collapse the webhook fleet.
 *
 * Fails open on Redis unavailability, matching every other rate limit. The
 * downstream per-recipient backlog cap (migration 028:245, v_cap = 10,000)
 * remains the last line of defense against unbounded queue growth if Redis
 * is simultaneously unreachable AND an attack is in progress.
 *
 * Every cap hit is recorded in `rateLimitHits{rule='group_aggregate'}` for
 * Prometheus and also passes through `recordGroupAggregateHit` which fires a
 * Sentry alert on sustained spikes (see docstring above).
 */
export async function checkGroupAggregateRateLimit(conversationId: string): Promise<{
  allowed: boolean
  retryAfterMs?: number
}> {
  try {
    const redis = getRedis()
    const second = Math.floor(Date.now() / 1000)
    const key = `ratelimit:groupbucket:${conversationId}:${second}`

    const current = await redis.incr(key)
    if (current === 1) {
      await redis.expire(key, 3)
    }

    if (current > GROUP_AGGREGATE_RATE_LIMIT_PER_SECOND) {
      recordGroupAggregateHit(conversationId)
      const nowMs = Date.now()
      const nextSecondMs = (second + 1) * 1000
      return { allowed: false, retryAfterMs: nextSecondMs - nowMs }
    }

    return { allowed: true }
  } catch {
    console.error('[group-aggregate-rate-limit] Redis unavailable — failing open')
    return { allowed: true }
  }
}

/**
 * Test-only: resets the in-process hit counter and last-alert timestamp. The
 * production alert path is module-level state for a reason (a single counter
 * per process is the correct granularity for this alert), but tests need to
 * reset between cases. Exported with an underscore prefix so it's obvious at
 * the call site that this is not part of the public surface.
 */
export function _resetGroupAggregateAlertStateForTests(): void {
  groupAggregateHitsInWindow = 0
  groupAggregateWindowStartedAt = Date.now()
  groupAggregateLastAlertAt = 0
  groupAggregateLastOffendingConvId = null
}

// ─── Rule 4: Group invite cap ───────────────────────────────────────────────

/**
 * Per-sender rolling 24h cap on group invites. Counts both auto-added
 * and pending invites — the cap exists to bound nuisance attention cost
 * on recipients, and both outcomes pull on that budget equally.
 *
 * Implemented as a fixed 24h expiring counter in Redis (not a true
 * sliding window — sliding would require ZSET machinery we don't need
 * at Phase 1 scale). The counter resets 24h after its first entry in
 * the current window, which means a burst-and-wait attacker could
 * theoretically push slightly over the cap at window rollover. That's
 * acceptable — the cap is a coarse nuisance guardrail, not a precise
 * anti-abuse bound (the real wall is the per-agent
 * group_invite_policy + block + report enforcement).
 *
 * Fails open on Redis unavailability, mirroring the other rate limits:
 * degrading to "no invite cap" is less bad than freezing the group
 * feature entirely.
 */
export async function checkGroupInviteCap(agentId: string): Promise<{
  allowed: boolean
  current: number
  limit: number
}> {
  const limit = GROUP_INVITES_PER_DAY
  try {
    const redis = getRedis()
    const key = `ratelimit:groupinvites:24h:${agentId}`
    const current = await redis.incr(key)
    if (current === 1) {
      await redis.expire(key, 24 * 60 * 60)
    }
    if (current > limit) {
      return { allowed: false, current, limit }
    }
    return { allowed: true, current, limit }
  } catch {
    console.error('[group-invite-cap] Redis unavailable — failing open')
    return { allowed: true, current: 0, limit }
  }
}
