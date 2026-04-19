import { refreshAnalyticsViews, type AnalyticsRefreshResult } from '@agentchat/db'
import {
  analyticsRefreshDurationSeconds,
  analyticsRefreshLastSuccess,
  analyticsRefreshOutcome,
} from '../lib/metrics.js'
import { logger } from '../lib/logger.js'
import { Sentry } from '../instrument.js'

/**
 * Analytics refresh scheduler (migration 042).
 *
 * Drives hourly refreshes of the `analytics.mv_*` matviews so Metabase reads
 * pre-aggregated snapshots instead of scanning partitioned `messages` /
 * `message_deliveries` on every dashboard load. The SQL side
 * (public.refresh_analytics_views) owns the heavy lifting: advisory lock,
 * cadence guard, audit log row, savepoint-scoped error handling. This
 * service is the driver: it ticks, observes outcomes to Prometheus, and
 * pages Sentry on streaked failures.
 *
 * ─── Why the worker (not pg_cron, not an api request) ───────────────────
 *
 * pg_cron: Supabase free tier availability is flaky, and the worker already
 * runs on Fly with Sentry wired up. Running the tick from app-space gives us
 * observability (metrics + logs + alerts) for free; the SQL function handles
 * the concurrency safety so running it from multiple workers is a non-issue.
 *
 * api request path: a refresh can take tens of seconds once volume grows.
 * That has no business blocking a request-path tick interval or occupying a
 * request-path DB connection.
 *
 * ─── Tick cadence ────────────────────────────────────────────────────────
 *
 * TICK_INTERVAL_MS = 1 hour. Growth dashboards don't need sub-hour freshness —
 * "daily signups" is a one-decimal-place signal on a day-granularity axis,
 * and the underlying matviews compound over the full history anyway. Once
 * per hour keeps the refresh budget tiny (single-digit seconds at current
 * volume) without pointless churn.
 *
 * MIN_REFRESH_INTERVAL_MIN = 50. Slightly under the tick interval so a
 * worker restart or a deploy that fires the bootstrap tick (see below) a
 * few minutes after a peer's successful refresh lands `too_soon` rather
 * than a redundant refresh. 50 chosen so clock skew between workers up to
 * ~9 minutes doesn't cause the guard to miss.
 *
 * BOOTSTRAP_DELAY_MS = 2 min. First tick is delayed so:
 *   - migrations have finished on first deploy (migration 042 must have run
 *     before we call the function it defines)
 *   - transient boot noise (config loads, pub/sub connects) is out of the
 *     way before we issue a potentially-seconds-long query
 *   - workers landing simultaneously on a rolling deploy stagger their
 *     bootstraps against the per-pod start time rather than colliding on
 *     the advisory lock immediately
 *
 * ─── Concurrency ─────────────────────────────────────────────────────────
 *
 * Three worker machines run this service. Only one actually refreshes per
 * tick — the other two see `lock_held` or `too_soon` and move on. That's
 * the whole point of the SQL-side lock + cadence guard combo: we don't need
 * application-level leader election here.
 *
 * Within a single worker, `running` prevents overlapping ticks — if a
 * refresh is still in flight when the next tick fires (unexpected at our
 * volumes, but possible as tables grow), we skip that firing rather than
 * stacking.
 *
 * ─── Failure handling ───────────────────────────────────────────────────
 *
 * Three failure flavors, distinguished in metrics and alerts:
 *   1. SQL function returned `reason: 'error'` — the refresh itself failed
 *      inside the savepoint, audit row was still written. Counter labeled
 *      outcome=failed.
 *   2. This service threw — transport / auth / shape failure. We never
 *      reached the function. Counter labeled outcome=error.
 *   3. Skips — not failures. Counter labeled outcome=skipped_lock or
 *      skipped_cadence so dashboards can distinguish "blocked by peer"
 *      from "guarded by cadence".
 *
 * Any (1) or (2) outcome counts against a streak. FAILURE_STREAK_ALERT on
 * 3 consecutive means roughly 3 hours of degraded freshness — Metabase
 * dashboards will show staleness, and ops gets paged once (not on every
 * tick). The streak is cleared on the next success with a single resolve
 * log — mirroring the dlq-probe hysteresis pattern.
 */

const TICK_INTERVAL_MS = 60 * 60 * 1000 // 1 hour
const MIN_REFRESH_INTERVAL_MIN = 50 // See header: below tick interval, above clock-skew budget
const BOOTSTRAP_DELAY_MS = 2 * 60 * 1000 // 2 min — migrations, boot noise, stagger

// Three consecutive failures ≈ 3 hours without a refresh. Tight enough that
// stale dashboards get surfaced within a working half-day; loose enough that
// a single transient DB blip doesn't page on-call.
const FAILURE_STREAK_ALERT_THRESHOLD = 3

let tickTimer: NodeJS.Timeout | null = null
let bootstrapTimer: NodeJS.Timeout | null = null
let running = false
let stopped = false
let failureStreak = 0
let alerted = false

export function startAnalyticsRefresh(): void {
  if (tickTimer || bootstrapTimer) return
  stopped = false

  // Schedule the first tick after the bootstrap delay, then the periodic
  // interval. Kept separate from the setInterval so we don't run at t=0
  // (which would race migration completion on the first deploy after 042
  // lands) and don't run at t=TICK_INTERVAL either (an hour of dead time
  // during which the Prometheus gauge shows staleness the dashboard sees).
  bootstrapTimer = setTimeout(() => {
    bootstrapTimer = null
    void tick()
    tickTimer = setInterval(() => {
      void tick()
    }, TICK_INTERVAL_MS)
  }, BOOTSTRAP_DELAY_MS)

  logger.info(
    {
      tick_interval_ms: TICK_INTERVAL_MS,
      bootstrap_delay_ms: BOOTSTRAP_DELAY_MS,
      min_refresh_interval_min: MIN_REFRESH_INTERVAL_MIN,
      failure_streak_threshold: FAILURE_STREAK_ALERT_THRESHOLD,
    },
    'analytics_refresh_started',
  )
}

export async function stopAnalyticsRefresh(): Promise<void> {
  stopped = true
  if (bootstrapTimer) {
    clearTimeout(bootstrapTimer)
    bootstrapTimer = null
  }
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
  // A single in-flight tick can run for tens of seconds (REFRESH MAT VIEW
  // CONCURRENTLY is not cheap at scale). Wait it out so graceful shutdown
  // doesn't kill the DB connection mid-REFRESH — which would leave the
  // advisory lock released (transaction-scoped, ends with connection) but
  // the audit row stuck in status='in_progress'. A clean shutdown finishes
  // the savepoint block and updates the row to success/failed.
  //
  // Poll loop rather than a promise handle because `tick()` is fire-and-
  // forget on the interval; tracking a shared promise across ticks would
  // add complexity for zero benefit here (only one tick runs at a time).
  const deadline = Date.now() + 60_000
  while (running && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
  }
  logger.info('analytics_refresh_stopped')
}

async function tick(): Promise<void> {
  if (running || stopped) return
  running = true
  const startedAtMs = Date.now()
  try {
    const result = await refreshAnalyticsViews(MIN_REFRESH_INTERVAL_MIN)
    observeOutcome(result, startedAtMs)
  } catch (err) {
    // Transport / auth / shape failure — we never reached the SQL function,
    // or we reached it but the response shape was wrong. Distinct from a
    // function-side refresh error (which returns the `error` variant
    // instead of throwing).
    analyticsRefreshOutcome.inc({ outcome: 'error' })
    logger.error({ err }, 'analytics_refresh_rpc_failed')
    Sentry.captureException(err, { tags: { component: 'analytics-refresh' } })
    bumpFailureStreak('rpc_error')
  } finally {
    running = false
  }
}

function observeOutcome(
  result: AnalyticsRefreshResult,
  startedAtMs: number,
): void {
  if (result.refreshed === true) {
    analyticsRefreshOutcome.inc({ outcome: 'success' })
    // Observe the SQL-reported duration — it's the authoritative measure
    // of the refresh itself, excluding RPC round-trip. Falls back to the
    // wall-clock delta if the function returned zero (initial-population
    // row in migration 042 has duration_ms=0 but that row was INSERTed
    // directly, not by this service).
    const durationSec =
      result.duration_ms > 0
        ? result.duration_ms / 1000
        : (Date.now() - startedAtMs) / 1000
    analyticsRefreshDurationSeconds.observe(durationSec)
    analyticsRefreshLastSuccess.set(() => Math.floor(Date.now() / 1000))
    clearFailureStreak()
    logger.info(
      {
        log_id: result.log_id,
        duration_ms: result.duration_ms,
        views_count: result.views_count,
      },
      'analytics_refresh_success',
    )
    return
  }

  switch (result.reason) {
    case 'lock_held':
      // Another worker is refreshing right now. Expected every tick in a
      // 3-machine pool — 2/3 of ticks land here. Not a failure.
      analyticsRefreshOutcome.inc({ outcome: 'skipped_lock' })
      logger.debug('analytics_refresh_skipped_lock_held')
      return

    case 'too_soon':
      // A peer refreshed within MIN_REFRESH_INTERVAL_MIN. Bootstrap after a
      // rolling deploy lands here frequently. Not a failure.
      analyticsRefreshOutcome.inc({ outcome: 'skipped_cadence' })
      logger.debug(
        { last_completed_at: result.last_completed_at },
        'analytics_refresh_skipped_too_soon',
      )
      return

    case 'error':
      // The SQL function reached the REFRESH loop and one of the matviews
      // raised. The audit row has status='failed' and error=SQLERRM — the
      // exception branch committed that update before returning this
      // variant. Counts against the streak.
      analyticsRefreshOutcome.inc({ outcome: 'failed' })
      logger.error(
        { log_id: result.log_id, error: result.error },
        'analytics_refresh_failed',
      )
      Sentry.captureMessage('analytics_refresh_failed', {
        level: 'error',
        tags: { component: 'analytics-refresh' },
        extra: { log_id: result.log_id, error: result.error },
      })
      bumpFailureStreak('sql_error')
      return
  }
}

function bumpFailureStreak(kind: 'rpc_error' | 'sql_error'): void {
  failureStreak += 1
  if (failureStreak >= FAILURE_STREAK_ALERT_THRESHOLD && !alerted) {
    alerted = true
    Sentry.captureMessage('analytics_refresh_streak_breach', {
      level: 'error',
      tags: { component: 'analytics-refresh' },
      extra: {
        streak_ticks: failureStreak,
        threshold: FAILURE_STREAK_ALERT_THRESHOLD,
        tick_interval_ms: TICK_INTERVAL_MS,
        latest_kind: kind,
      },
    })
    logger.error(
      {
        streak_ticks: failureStreak,
        threshold: FAILURE_STREAK_ALERT_THRESHOLD,
        latest_kind: kind,
      },
      'analytics_refresh_streak_breach',
    )
  }
}

function clearFailureStreak(): void {
  if (alerted) {
    // Emit a resolution log (Sentry doesn't have a canonical "resolved"
    // event; on-call only needs to know the original alert is no longer
    // breaching). Same pattern as dlq-probe's resolution path.
    logger.warn(
      { previous_streak: failureStreak },
      'analytics_refresh_streak_resolved',
    )
  }
  failureStreak = 0
  alerted = false
}

// Test hook — drive one tick synchronously and wait for it to settle.
// Mirrors the _tickForTests export from outbox-worker.ts; same reasoning
// (production tick is fire-and-forget on an interval, tests need await).
export async function _tickForTests(): Promise<void> {
  await tick()
}
