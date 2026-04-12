import { createHmac } from 'node:crypto'
import {
  claimWebhookDeliveries,
  markWebhookDelivered,
  scheduleWebhookRetry,
  markWebhookDead,
  updateDeliveryStatus,
  type WebhookDeliveryRow,
} from '@agentchat/db'
import { webhookDeliveries } from '../lib/metrics.js'

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

const POLL_INTERVAL_MS = 5_000
const BATCH_SIZE = 10
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
let running = false
let stopped = false

export function startWebhookWorker() {
  if (pollTimer) return
  stopped = false
  pollTimer = setInterval(() => {
    void tick()
  }, POLL_INTERVAL_MS)
  // Fire an immediate tick so startup doesn't wait POLL_INTERVAL for the
  // first poll. Not awaited — the interval handles future ticks.
  void tick()
  console.log(`[webhook-worker] started (poll=${POLL_INTERVAL_MS}ms, batch=${BATCH_SIZE})`)
}

export function stopWebhookWorker() {
  stopped = true
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  console.log('[webhook-worker] stopped')
}

async function tick() {
  // Re-entrancy guard: if the previous tick is still processing (slow DB,
  // high row count), skip this one rather than stacking work.
  if (running || stopped) return
  running = true
  try {
    const rows = await claimWebhookDeliveries(BATCH_SIZE)
    if (rows.length === 0) return

    // Fire all attempts in parallel — each row is independent and the HTTP
    // fetch is the bottleneck. Settle them so one slow receiver can't block
    // the whole batch from finalizing in the DB.
    await Promise.allSettled(rows.map((row) => processRow(row)))
  } catch (err) {
    console.error('[webhook-worker] claim failed:', err)
  } finally {
    running = false
  }
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
      // For message.new events, this worker is the signal that the agent's
      // webhook receiver actually got the message — mark the per-recipient
      // envelope so sync/drain won't replay it. Pub/sub + WS push marks the
      // same envelope from its own path; whichever finishes first wins, and
      // the forward-only status guard ignores the second call.
      await markEnvelopeDelivered(row)
      return
    }

    const errText = `HTTP ${response.status} ${response.statusText}`
    await scheduleNextAttempt(row, errText)
  } catch (err) {
    const errText = err instanceof Error ? err.message : String(err)
    await scheduleNextAttempt(row, errText)
  }
}

async function scheduleNextAttempt(row: WebhookDeliveryRow, errText: string) {
  // row.attempts was already incremented by the claim RPC, so it reflects
  // the attempt that just failed.
  if (row.attempts >= MAX_ATTEMPTS) {
    webhookDeliveries.inc({ outcome: 'dead' })
    await markWebhookDead(row.id, errText).catch((e) => {
      console.error('[webhook-worker] markDead failed:', e)
    })
    return
  }

  webhookDeliveries.inc({ outcome: 'failed' })
  const delayMs = RETRY_DELAYS_MS[row.attempts - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!
  const nextAt = new Date(Date.now() + delayMs)
  await scheduleWebhookRetry(row.id, nextAt, errText).catch((e) => {
    console.error('[webhook-worker] scheduleRetry failed:', e)
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
