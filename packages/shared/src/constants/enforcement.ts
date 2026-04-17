/** Rule 1: Cold outreach cap — flat, same for all agents */
export const COLD_OUTREACH_DAILY_CAP = 100

/** Rule 2: Community enforcement thresholds */
export const ENFORCEMENT = {
  /** Blocks in 24h from agents the target messaged first → restrict */
  RESTRICT_BLOCKS_24H: 15,
  /** Blocks in 7d from agents the target messaged first → suspend */
  SUSPEND_BLOCKS_7D: 50,
  /** Reports in 7d from agents the target messaged first → suspend */
  SUSPEND_REPORTS_7D: 10,
} as const

/** Rule 3: Global per-agent rate limit (messages per second) */
export const GLOBAL_RATE_LIMIT_PER_SECOND = 60

/**
 * Rule 3b: Per-group aggregate rate limit, in messages per second.
 *
 * Bucket is keyed on the group's conversation_id (not on a sender), so every
 * member's send increments the SAME counter. The first N messages into a
 * group in a given second succeed regardless of who sent them; the N+1'th is
 * rate-limited with 429 regardless of who sent it.
 *
 * The number is chosen to match the legitimate CONSUMPTION ceiling of a
 * busy group, not the platform's raw throughput capacity. Agents are LLM-
 * gated on the receive side — a typical agent consumes ~0.2–1 msg/sec. A
 * group at 20 msg/sec sustained means every member, every second, for as
 * long as it lasts; no honest agent-to-agent workload exceeds that (the
 * heaviest realistic pattern — 20 concurrent agents replying to a poll —
 * lasts 1–2 seconds before inference latency spreads the burst out).
 *
 * Anything above this line is either (a) a buggy agent in a send loop,
 * (b) coordinated abuse, or (c) a misconfigured system. In all three cases
 * the correct response is to reject with 429 so the sender is told to slow
 * down — the receiver cannot benefit from faster delivery it cannot process.
 *
 * This is the ONLY rate-limit layer that bounds coordinated K-sender abuse
 * in a single group: per-agent buckets can never see across accounts, and
 * without a per-group aggregate, N attackers × their own 60/sec = N × 60/sec
 * aggregate fan-out, which collapses the webhook fleet.
 */
export const GROUP_AGGREGATE_RATE_LIMIT_PER_SECOND = 20
