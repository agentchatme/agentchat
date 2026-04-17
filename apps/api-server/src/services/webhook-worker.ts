import { createHmac } from 'node:crypto'
import {
  claimWebhookDeliveries,
  markWebhookDelivered,
  scheduleWebhookRetry,
  moveWebhookToDlq,
  updateDeliveryStatus,
  type WebhookDeliveryRow,
} from '@agentchat/db'
import { webhookDeliveries } from '../lib/metrics.js'
import { logger } from '../lib/logger.js'
import {
  getOpenWebhookIds,
  recordWebhookFailure,
  recordWebhookSuccess,
} from './webhook-circuit-breaker.js'

/**
 * Background webhook delivery worker.
 *
 * Polls webhook_deliveries every POLL_INTERVAL_MS, claims up to BATCH_SIZE
 * rows at a time via the claim_webhook_deliveries RPC (which uses FOR
 * UPDATE SKIP LOCKED so multiple api-server instances don't double-process
 * the same row), and fires the HTTP delivery for each. Status transitions:
 *
 *   pending/failed/stale-delivering  → delivering (done by RPC)
 *   delivering → delivered           (2xx response)
 *   delivering → failed              (non-2xx or network error, attempts < max)
 *   delivering → dead                (non-2xx or network error, attempts >= max)
 *
 * The retry schedule is geometric-ish: 10s, 30s, 1m, 5m, 15m, 1h, 6h, 24h.
 * Initial attempt + 8 delays means a delivery exhausts retries roughly 31
 * hours after enqueue, at which point it lands in the 'dead' DLQ state.
 *
 * Each HTTP request has a 10s timeout, which is intentionally longer than
 * the common "slow receiver" threshold — we'd rather burn a slot waiting
 * than mark a live receiver as failed.
 */

// Poll cadence + claim batch jointly set the per-worker delivery ceiling:
// roughly BATCH_SIZE / (POLL_INTERVAL_MS / 1000) per second per worker.
// 50 / 1s = ~50/s/worker, × 2 worker machines = ~100/s steady state — sized
// to the audit's "1M agents × 1 msg/day × 3 webhooks ≈ 100/s" projection
// without burning through Postgres connection budget at idle. The receiver-
// timeout is the hard ceiling (a batch of 50 can't drain faster than the
// slowest of 50 parallel HTTP fetches), so the next tick reliably has work
// queued for it instead of stacking re-entrant ticks.
const POLL_INTERVAL_MS = 1_000
const BATCH_SIZE = 50
const REQUEST_TIMEOUT_MS = 10_000

// Delays AFTER each failure, in milliseconds. Index N is the wait after the
// Nth failure (so delay[0] = after attempt 1). Length = 8, meaning attempt 9
// is the last; if it fails, the row is marked 'dead'.
const RETRY_DELAYS_MS = [
  10_000, // 10s
  30_000, // 30s
  60_000, // 1m
  300_000, // 5m
  900_000, // 15m
  3_600_000, // 1h
  21_600_000, // 6h
  86_400_000, // 24h
] as const

const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1 // initial + 8 retries = 9

let pollTimer: NodeJS.Timeout | null = null
let stopped = false
// Track the in-flight tick promise so graceful shutdown can wait for it
// to complete instead of leaving a half-claimed batch in 'delivering' for
// the 60s stale-row reclaim window. Was previously a boolean — the
// boolean was fine for re-entrancy but useless for shutdown coordination.
let inFlight: Promise<void> | null = null

export function startWebhookWorker() {
  if (pollTimer) return
  stopped = false
  pollTimer = setInterval(() => {
    void tick()
  }, POLL_INTERVAL_MS)
  // Fire an immediate tick so startup doesn't wait POLL_INTERVAL for the
  // first poll. Not awaited — the interval handles future ticks.
  void tick()
  logger.info(
    { poll_ms: POLL_INTERVAL_MS, batch_size: BATCH_SIZE },
    'webhook_worker_started',
  )
}

/** Stop polling and wait for the current tick (if any) to finish. Resolves
 *  when the worker is fully quiesced, so SIGTERM handlers can sequence DB
 *  shutdown after this without tearing connections out from under an
 *  in-progress claim → fetch → mark cycle. */
export async function stopWebhookWorker(): Promise<void> {
  stopped = true
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (inFlight) {
    try {
      await inFlight
    } catch {
      // tick() catches its own errors; this await only sees abnormal
      // settle paths, which we ignore so shutdown still completes.
    }
  }
  logger.info('webhook_worker_stopped')
}

function tick(): void {
  // Re-entrancy guard: if the previous tick is still processing (slow DB,
  // high row count), skip this one rather than stacking work. Tracking the
  // promise (rather than a boolean flag) lets stopWebhookWorker await
  // completion during graceful shutdown.
  if (inFlight || stopped) return
  inFlight = (async () => {
    try {
      // §3.4.3: pull the set of webhook ids currently behind an open
      // circuit so the claim RPC leaves their rows in 'pending' (no
      // attempt burn). The Lua evaluation also auto-promotes expired OPEN
      // circuits into HALF_OPEN, letting the next claim pull exactly one
      // probe row per recovering endpoint. Fails open on Redis outage.
      const excludedWebhookIds = await getOpenWebhookIds()
      const rows = await claimWebhookDeliveries(BATCH_SIZE, excludedWebhookIds)
      if (rows.length === 0) return

      // Fire all attempts in parallel — each row is independent and the
      // HTTP fetch is the bottleneck. Settle them so one slow receiver
      // can't block the whole batch from finalizing in the DB.
      await Promise.allSettled(rows.map((row) => processRow(row)))
    } catch (err) {
      logger.error({ err }, 'webhook_worker_tick_failed')
    } finally {
      inFlight = null
    }
  })()
}

async function processRow(row: WebhookDeliveryRow) {
  const body = JSON.stringify(row.payload)
  const signature = createHmac('sha256', row.secret).update(body).digest('hex')

  try {
    const response = await fetch(row.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AgentChat-Signature': signature,
        'X-AgentChat-Event': row.event,
        'X-AgentChat-Delivery': row.id,
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (response.ok) {
      await markWebhookDelivered(row.id)
      webhookDeliveries.inc({ outcome: 'delivered' })
      // §3.4.3: reset the circuit for this endpoint. Clears any
      // accumulated failure state and, for a probe fired from half_open,
      // transitions it back to closed.
      await recordWebhookSuccess(row.webhook_id)
      // For message.new events, this worker is the signal that the agent's
      // webhook receiver actually got the message — mark the per-recipient
      // envelope so sync/drain won't replay it. Pub/sub + WS push marks the
      // same envelope from its own path; whichever finishes first wins, and
      // the forward-only status guard ignores the second call.
      await markEnvelopeDelivered(row)
      return
    }

    const errText = `HTTP ${response.status} ${response.statusText}`
    await recordWebhookFailure(row.webhook_id)
    await scheduleNextAttempt(row, errText)
  } catch (err) {
    const errText = err instanceof Error ? err.message : String(err)
    await recordWebhookFailure(row.webhook_id)
    await scheduleNextAttempt(row, errText)
  }
}

async function scheduleNextAttempt(row: WebhookDeliveryRow, errText: string) {
  // row.attempts was already incremented by the claim RPC, so it reflects
  // the attempt that just failed.
  if (row.attempts >= MAX_ATTEMPTS) {
    webhookDeliveries.inc({ outcome: 'dead' })
    // Transition into the dedicated DLQ table (migration 032). Previously
    // this was markWebhookDead() which just set status='dead' on the row
    // in place, polluting the primary queue heap. The DLQ is a separate
    // table with its own time-ordered index and a replay_webhook_dlq
    // function for operator intervention. The dlq-probe already alerts on
    // sustained growth in countDeadWebhookDeliveries (now pointing at the
    // DLQ table), so per-move Sentry is unnecessary — the rolling-window
    // alert is the on-call signal.
    logger.warn(
      {
        delivery_id: row.id,
        webhook_id: row.webhook_id,
        agent_id: row.agent_id,
        attempts: row.attempts,
        last_error: errText.slice(0, 256),
      },
      'webhook_delivery_moved_to_dlq',
    )
    await moveWebhookToDlq(row.id, errText).catch((err) => {
      logger.error({ err, delivery_id: row.id }, 'webhook_move_to_dlq_failed')
    })
    return
  }

  webhookDeliveries.inc({ outcome: 'failed' })
  const delayMs = RETRY_DELAYS_MS[row.attempts - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!
  const nextAt = new Date(Date.now() + delayMs)
  await scheduleWebhookRetry(row.id, nextAt, errText).catch((err) => {
    logger.error({ err, delivery_id: row.id }, 'webhook_schedule_retry_failed')
  })
}

async function markEnvelopeDelivered(row: WebhookDeliveryRow) {
  if (row.event !== 'message.new') return
  const data = (row.payload as { data?: { id?: unknown } }).data
  const messageId = data?.id
  if (typeof messageId !== 'string') return
  await updateDeliveryStatus(messageId, row.agent_id, 'delivered').catch(() => {
    // Envelope marking is best-effort — the forward-only status guard
    // handles races with WS/pub-sub marking it first.
  })
}

// Test-only hooks. scheduleNextAttempt encapsulates the terminal-state
// decision (retry vs DLQ) and is the one branch worth asserting at the
// TypeScript layer — the actual HTTP and SQL sides are mocked in the test.
// Underscore prefix mirrors the convention used elsewhere in this codebase.
export { scheduleNextAttempt as _scheduleNextAttemptForTests }
export const _MAX_ATTEMPTS_FOR_TESTS = MAX_ATTEMPTS
