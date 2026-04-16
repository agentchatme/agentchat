import {
  countDeadWebhookDeliveries,
  countDeadGroupDeletionFanout,
  measureUndeliveredDrift,
} from '@agentchat/db'
import {
  webhooksDead,
  webhookCircuitsOpen,
  undeliveredCountDrift,
  groupDeletionFanoutDead,
} from '../lib/metrics.js'
import { logger } from '../lib/logger.js'
import { Sentry } from '../instrument.js'
import { getOpenWebhookIds } from './webhook-circuit-breaker.js'

/**
 * Periodic dead-letter-queue health probe for the webhook delivery pipeline.
 *
 * Runs in the worker process (not api-server) so the count query doesn't
 * compete with request-path latency. Two responsibilities:
 *
 *   1. Refresh the `agentchat_webhook_deliveries_dead` Prometheus gauge so
 *      Grafana dashboards / alertmanager rules can see DLQ growth without
 *      having to query Postgres themselves on every scrape.
 *   2. If the count over the last hour crosses ALERT_THRESHOLD, emit a
 *      single Sentry message so on-call gets paged when the DLQ is filling
 *      up faster than the operator can drain it. Sentry's own grouping will
 *      collapse repeats; we don't try to dedupe locally.
 *
 * Window is "last hour" rather than all-time because:
 *   - all-time grows monotonically and would silently breach the threshold
 *     once and then alert forever;
 *   - an hourly window gives a rate-of-arrival signal — a sudden spike from
 *     a pricing bug or a failing receiver shows up immediately, while old
 *     dead rows that the operator has already triaged don't keep paging.
 *
 * The probe interval is intentionally slower than the webhook poll loop —
 * DLQ growth is not a fast-moving signal, and a count(*) over a partitioned
 * table isn't free.
 */

// 5 minutes. Balances "alert fires within an SLA-relevant window" against
// "we're not hammering Postgres with count(*) queries". Cache-warm cost is
// dominated by the index scan over (status, created_at) which we get for
// free from the existing `webhook_deliveries_status_next_attempt_idx` index.
const PROBE_INTERVAL_MS = 5 * 60 * 1000

// One hour. Counts dead rows that landed in this window — see header comment
// for why a rolling window beats all-time.
const PROBE_WINDOW_MS = 60 * 60 * 1000

// Alert threshold. 100 dead rows in an hour ≈ 1.7/min, well above background
// noise from a single bad receiver but well below "everything is on fire".
// Tune from production data once we have a baseline; conservative starting
// point so we don't bury on-call in false positives during launch.
const ALERT_THRESHOLD = 100

// Hysteresis thresholds for the two non-binary signals (drift, circuits
// open). A bare threshold would alert-and-resolve on every flap; the
// streak requirement filters transient blips, and the lower resolve
// threshold prevents oscillation when the signal hovers right at the
// alert line.
//
// DRIFT: |counter_sum - actual_count|. Should be 0 in steady state.
// Sustained non-zero means a code path mutated message_deliveries.status
// without going through the trigger that maintains agents.undelivered_count
// — bug or manual UPDATE somewhere. 100 is well above the natural lag
// from snapshot skew (the two queries don't run in the same transaction),
// 3 ticks at 5-min cadence = 15 min of sustained drift before paging.
const DRIFT_ALERT_THRESHOLD = 100
const DRIFT_RESOLVE_THRESHOLD = 50
const DRIFT_BREACH_STREAK_REQUIRED = 3

// CIRCUITS OPEN: number of webhook endpoints in OPEN state right now. A
// single bad receiver opens one circuit and is normal background noise;
// 10+ simultaneously open means a broader event (DNS outage, region-wide
// SaaS down, our own HTTP client misbehaving). 2 ticks = 10 min of
// sustained breach before paging — long enough to ride out a brief blip.
const CIRCUITS_ALERT_THRESHOLD = 10
const CIRCUITS_RESOLVE_THRESHOLD = 5
const CIRCUITS_BREACH_STREAK_REQUIRED = 2

let probeTimer: NodeJS.Timeout | null = null
let running = false
let stopped = false
let lastCount = 0
let lastCircuitsOpen = 0
let lastDrift = 0
let lastFanoutDead = 0

// Hysteresis state. Streak counters increment each tick the signal is
// past the alert threshold and reset to 0 once it falls below the
// resolve threshold. The boolean tracks whether we've already paged so
// we can log the resolution exactly once on the way back down.
let driftBreachStreak = 0
let driftAlerted = false
let circuitsBreachStreak = 0
let circuitsAlerted = false

// The gauge's provider closures are set once at start() time; they read
// the most recent values we computed. Polling refreshes the cached value
// rather than running the query inline on every Prometheus scrape (which
// would stampede if multiple scrapers hit us within seconds of each
// other). All three gauges (DLQ depth, circuit-open count, undelivered
// drift) share one tick — they're cheap when they're cheap and the
// shared cadence keeps the worker's DB connection budget predictable.
export function startDlqProbe() {
  if (probeTimer) return
  stopped = false
  webhooksDead.set(() => lastCount)
  webhookCircuitsOpen.set(() => lastCircuitsOpen)
  undeliveredCountDrift.set(() => lastDrift)
  groupDeletionFanoutDead.set(() => lastFanoutDead)

  probeTimer = setInterval(() => {
    void tick()
  }, PROBE_INTERVAL_MS)

  // Run once immediately so the gauges are non-zero before the first scrape
  // — otherwise a fresh boot reports 0 for up to PROBE_INTERVAL_MS even if
  // the DLQ is full or drift is growing.
  void tick()
  logger.info(
    { interval_ms: PROBE_INTERVAL_MS, window_ms: PROBE_WINDOW_MS, threshold: ALERT_THRESHOLD },
    'dlq_probe_started',
  )
}

export function stopDlqProbe() {
  stopped = true
  if (probeTimer) {
    clearInterval(probeTimer)
    probeTimer = null
  }
  logger.info('dlq_probe_stopped')
}

async function tick() {
  if (running || stopped) return
  running = true
  try {
    // Run the four measurements in parallel — they hit different
    // backends (Postgres count, Postgres aggregate+count, Redis EVAL,
    // Postgres count) and one slow leg shouldn't delay the others.
    // allSettled so a single failing leg leaves its previous gauge value
    // intact rather than zeroing every gauge on a transient outage.
    const [deadRes, driftRes, openRes, fanoutDeadRes] = await Promise.allSettled([
      countDeadWebhookDeliveries(PROBE_WINDOW_MS),
      measureUndeliveredDrift(),
      getOpenWebhookIds(),
      countDeadGroupDeletionFanout(PROBE_WINDOW_MS),
    ])

    if (driftRes.status === 'fulfilled') {
      lastDrift = driftRes.value.counterSum - driftRes.value.actualCount
      evaluateDriftAlert(lastDrift)
    } else {
      logger.error({ err: driftRes.reason }, 'dlq_probe_drift_failed')
    }

    if (openRes.status === 'fulfilled') {
      lastCircuitsOpen = openRes.value.length
      evaluateCircuitsAlert(lastCircuitsOpen)
    } else {
      logger.error({ err: openRes.reason }, 'dlq_probe_circuits_failed')
    }

    if (fanoutDeadRes.status === 'fulfilled') {
      lastFanoutDead = fanoutDeadRes.value
      if (lastFanoutDead >= ALERT_THRESHOLD) {
        Sentry.captureMessage('group_deletion_fanout_dlq_threshold_breach', {
          level: 'error',
          tags: { component: 'group-deletion-fanout-worker' },
          extra: {
            dead_count: lastFanoutDead,
            window_ms: PROBE_WINDOW_MS,
            threshold: ALERT_THRESHOLD,
          },
        })
        logger.error(
          { dead_count: lastFanoutDead, window_ms: PROBE_WINDOW_MS, threshold: ALERT_THRESHOLD },
          'group_deletion_fanout_dlq_threshold_breach',
        )
      }
    } else {
      logger.error({ err: fanoutDeadRes.reason }, 'dlq_probe_fanout_dead_failed')
    }

    if (deadRes.status === 'rejected') {
      // Fall through to the existing catch path — the dead count IS
      // the load-bearing measurement (drives the Sentry alert), so a
      // failure here should still surface the same way it did before.
      throw deadRes.reason
    }

    const count = deadRes.value
    lastCount = count

    if (count >= ALERT_THRESHOLD) {
      // captureMessage rather than captureException — there's no error
      // object here, just a metric crossing a line. level:'error' makes it
      // page on the default Sentry alerting policy.
      Sentry.captureMessage('webhook_dlq_threshold_breach', {
        level: 'error',
        tags: { component: 'webhook-worker' },
        extra: {
          dead_count: count,
          window_ms: PROBE_WINDOW_MS,
          threshold: ALERT_THRESHOLD,
        },
      })
      logger.error(
        { dead_count: count, window_ms: PROBE_WINDOW_MS, threshold: ALERT_THRESHOLD },
        'webhook_dlq_threshold_breach',
      )
    } else {
      logger.debug(
        {
          dead_count: count,
          fanout_dead_count: lastFanoutDead,
          window_ms: PROBE_WINDOW_MS,
          circuits_open: lastCircuitsOpen,
          undelivered_drift: lastDrift,
        },
        'dlq_probe_tick',
      )
    }
  } catch (err) {
    // Probe failure is itself a Sentry-worthy event — if we can't read the
    // DLQ count, we're flying blind on webhook health. But don't crash the
    // worker; another tick will retry.
    logger.error({ err }, 'dlq_probe_failed')
    Sentry.captureException(err, { tags: { component: 'dlq-probe' } })
  } finally {
    running = false
  }
}

// ─── Hysteresis-gated alerts ─────────────────────────────────────────────
//
// Both evaluators follow the same shape: track a streak counter, fire on
// streak >= required, mark alerted, and fire a single resolution message
// when the signal falls below the lower (resolve) threshold. Sentry's
// own grouping collapses repeats; we don't try to dedupe locally beyond
// the alerted/resolved transition.
//
// Resolution events are logged but NOT sent to Sentry — there's no
// canonical "resolved" event in Sentry's taxonomy, and on-call only
// needs to know "the original alert is no longer breaching".

function evaluateDriftAlert(drift: number): void {
  const magnitude = Math.abs(drift)

  if (magnitude >= DRIFT_ALERT_THRESHOLD) {
    driftBreachStreak += 1
    if (driftBreachStreak >= DRIFT_BREACH_STREAK_REQUIRED && !driftAlerted) {
      driftAlerted = true
      Sentry.captureMessage('undelivered_count_drift_breach', {
        level: 'error',
        tags: { component: 'dlq-probe' },
        extra: {
          drift,
          magnitude,
          threshold: DRIFT_ALERT_THRESHOLD,
          streak_ticks: driftBreachStreak,
          tick_interval_ms: PROBE_INTERVAL_MS,
        },
      })
      logger.error(
        {
          drift,
          magnitude,
          threshold: DRIFT_ALERT_THRESHOLD,
          streak_ticks: driftBreachStreak,
        },
        'undelivered_count_drift_breach',
      )
    }
  } else if (magnitude < DRIFT_RESOLVE_THRESHOLD) {
    if (driftAlerted) {
      logger.warn(
        { drift, magnitude, resolve_threshold: DRIFT_RESOLVE_THRESHOLD },
        'undelivered_count_drift_resolved',
      )
    }
    driftBreachStreak = 0
    driftAlerted = false
  }
  // Between resolve and alert thresholds → leave streak/alerted state as-is.
}

function evaluateCircuitsAlert(openCount: number): void {
  if (openCount >= CIRCUITS_ALERT_THRESHOLD) {
    circuitsBreachStreak += 1
    if (circuitsBreachStreak >= CIRCUITS_BREACH_STREAK_REQUIRED && !circuitsAlerted) {
      circuitsAlerted = true
      Sentry.captureMessage('webhook_circuits_open_breach', {
        level: 'error',
        tags: { component: 'webhook-worker' },
        extra: {
          circuits_open: openCount,
          threshold: CIRCUITS_ALERT_THRESHOLD,
          streak_ticks: circuitsBreachStreak,
          tick_interval_ms: PROBE_INTERVAL_MS,
        },
      })
      logger.error(
        {
          circuits_open: openCount,
          threshold: CIRCUITS_ALERT_THRESHOLD,
          streak_ticks: circuitsBreachStreak,
        },
        'webhook_circuits_open_breach',
      )
    }
  } else if (openCount < CIRCUITS_RESOLVE_THRESHOLD) {
    if (circuitsAlerted) {
      logger.warn(
        { circuits_open: openCount, resolve_threshold: CIRCUITS_RESOLVE_THRESHOLD },
        'webhook_circuits_open_resolved',
      )
    }
    circuitsBreachStreak = 0
    circuitsAlerted = false
  }
}
