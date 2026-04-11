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
