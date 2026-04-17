import { createHash } from 'node:crypto'
import {
  claimMessageOutbox,
  findAgentById,
  getMessagesByIds,
  getWebhooksForAgentsAndEvent,
  processOutboxRow,
  recordOutboxFailure,
  type MessageOutboxRow,
  type OutboxWebhookInsert,
} from '@agentchat/db'
import { logger } from '../lib/logger.js'
import { outboxProcessed, outboxTickSeconds } from '../lib/metrics.js'

/**
 * Background outbox worker.
 *
 * Drains `message_outbox` (migration 031). Each claimed row represents:
 *   "when message X committed, target agent Y should receive a `message.new`
 *    webhook — figure out which subscriptions match and persist the
 *    webhook_deliveries rows."
 *
 * The outbox was written in the SAME transaction as the message + deliveries
 * inside send_message_atomic. That closed the old post-commit enqueue gap
 * where an api-server crash between `COMMIT` and `fireWebhooks(...)` dropped
 * webhook events on the floor without touching the message.
 *
 * Unlike webhook-worker.ts, this tick makes NO external HTTP calls — its only
 * side effects are DB-local. So the budget is tiny and we can poll hot
 * (500ms) with a larger batch. The tick's own Postgres calls dominate:
 *     1× claim_message_outbox (one RPC)
 *     1× SELECT messages by-ids
 *     1× SELECT agents by-ids (sender handles)
 *     1× SELECT webhooks by-agent-ids
 *     N× process_outbox_row (one per claimed row — serial for clarity,
 *        could be parallel if a tick ever becomes the bottleneck)
 *
 * Failure model: every step catches and funnels to recordOutboxFailure,
 * which releases the claim so the next tick picks the row up. The row's
 * `attempts` counter is bumped by the claim RPC on every pick-up, so after
 * enough cycles (logged + Sentry alerted via dlq-probe elsewhere) operators
 * can decide whether to purge or escalate. We deliberately do NOT mark rows
 * "dead" after N attempts — outbox failures are infrastructural (DB errors),
 * and the right recovery is "keep retrying until DB heals".
 */

const POLL_INTERVAL_MS = 500
const BATCH_SIZE = 200
const STALE_CLAIM_BUDGET_MS = 60_000 // matches claim_message_outbox stale threshold

let pollTimer: NodeJS.Timeout | null = null
let stopped = false
let inFlight: Promise<void> | null = null

export function startOutboxWorker() {
  if (pollTimer) return
  stopped = false
  pollTimer = setInterval(() => {
    void tick()
  }, POLL_INTERVAL_MS)
  void tick()
  logger.info(
    { poll_ms: POLL_INTERVAL_MS, batch_size: BATCH_SIZE },
    'outbox_worker_started',
  )
}

export async function stopOutboxWorker(): Promise<void> {
  stopped = true
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (inFlight) {
    try {
      await inFlight
    } catch {
      // tick() swallows its own errors; await here only to sequence
      // shutdown ordering with DB teardown.
    }
  }
  logger.info('outbox_worker_stopped')
}

function tick(): void {
  if (inFlight || stopped) return
  const startedAt = Date.now()
  inFlight = (async () => {
    try {
      const rows = await claimMessageOutbox(BATCH_SIZE)
      if (rows.length === 0) return
      await processBatch(rows)
    } catch (err) {
      // Catch-all — a top-level failure here means something broke before
      // individual-row failure handling could kick in (claim RPC errored,
      // DB connection lost mid-batch). Log + let the next tick try again.
      logger.error({ err }, 'outbox_worker_tick_failed')
    } finally {
      const tookMs = Date.now() - startedAt
      outboxTickSeconds.observe(tookMs / 1000)
      // A tick that runs longer than the stale-claim budget is its own
      // diagnostic: the next tick will reclaim the batch this one is still
      // working on, which doubles the work. Surfacing as a log now means
      // operators see it before the queue depth runs away.
      if (tookMs > STALE_CLAIM_BUDGET_MS) {
        logger.warn(
          { tookMs, batch_size: BATCH_SIZE },
          'outbox_worker_tick_slow',
        )
      }
      inFlight = null
    }
  })()
}

async function processBatch(rows: MessageOutboxRow[]): Promise<void> {
  // One-shot lookups across the whole batch so a big group message (256
  // outbox rows sharing the same message_id) doesn't issue 256 queries.
  const uniqueMessageIds = [...new Set(rows.map((r) => r.message_id))]
  const uniqueAgentIds = [...new Set(rows.map((r) => r.target_agent_id))]

  let messagesMap: Map<string, Record<string, unknown>>
  let webhooksByAgent: Map<
    string,
    Array<{ id: string; url: string; secret: string; events: string[] }>
  >
  try {
    const [msgs, whks] = await Promise.all([
      getMessagesByIds(uniqueMessageIds),
      // The outbox currently only carries 'message.new' events. If we
      // ever add other event types into the outbox (e.g., message.read),
      // this single-event lookup will need to partition by event and
      // issue one query per distinct event. Cheap to extend.
      getWebhooksForAgentsAndEvent(uniqueAgentIds, 'message.new'),
    ])
    messagesMap = msgs
    webhooksByAgent = whks
  } catch (err) {
    // Batch-level lookup failed — release every claim so the next tick
    // can retry with a fresh batch shape. Without this, a transient DB
    // blip would strand the whole batch in claimed state for 60s.
    logger.error({ err }, 'outbox_batch_lookup_failed')
    const errText = err instanceof Error ? err.message : String(err)
    await Promise.allSettled(
      rows.map((row) => recordOutboxFailure(row.id, `lookup:${errText}`)),
    )
    return
  }

  // Sender handles. A group message has one sender; a typical batch hits
  // a handful of unique senders. Pull them in parallel.
  const uniqueSenderIds = [
    ...new Set(
      [...messagesMap.values()]
        .map((m) => m.sender_id as string | undefined)
        .filter((x): x is string => typeof x === 'string'),
    ),
  ]
  const handleMap = new Map<string, string>()
  await Promise.allSettled(
    uniqueSenderIds.map(async (id) => {
      const agent = await findAgentById(id).catch(() => null)
      if (agent) handleMap.set(agent.id, agent.handle as string)
    }),
  )

  await Promise.allSettled(
    rows.map((row) =>
      processRow(row, messagesMap, handleMap, webhooksByAgent),
    ),
  )
}

async function processRow(
  row: MessageOutboxRow,
  messagesMap: Map<string, Record<string, unknown>>,
  handleMap: Map<string, string>,
  webhooksByAgent: Map<
    string,
    Array<{ id: string; url: string; secret: string; events: string[] }>
  >,
): Promise<void> {
  try {
    const message = messagesMap.get(row.message_id)
    if (!message) {
      // Message missing — the partition aged out, or it was hard-deleted.
      // Either way the event is moot. Process with empty webhook list so
      // the outbox row deletes cleanly and we stop retrying a ghost.
      logger.warn(
        { outbox_id: row.id, message_id: row.message_id },
        'outbox_message_not_found',
      )
      await processOutboxRow(row.id, [])
      outboxProcessed.inc({ outcome: 'orphaned' })
      return
    }

    const webhooks = webhooksByAgent.get(row.target_agent_id) ?? []
    if (webhooks.length === 0) {
      // No webhook subscriptions — no persistence needed. Row deletes.
      await processOutboxRow(row.id, [])
      outboxProcessed.inc({ outcome: 'no_webhooks' })
      return
    }

    const senderId = message.sender_id as string | undefined
    const senderHandle =
      (senderId && handleMap.get(senderId)) ?? 'unknown'

    const publicMessage = toPublicMessage(message, senderHandle)
    const payload = {
      event: row.event,
      timestamp: new Date().toISOString(),
      data: publicMessage,
    }

    const webhookRows: OutboxWebhookInsert[] = webhooks.map((wh) => ({
      // Deterministic id derived from (outbox_id, webhook_id). If a
      // reclaim-race causes two workers to process this row, both will
      // compute the same id — the ON CONFLICT DO NOTHING in
      // process_outbox_row collapses the duplicate insert. Without the
      // determinism, a race would double-deliver the webhook.
      id: deriveDeliveryId(row.id, wh.id),
      webhook_id: wh.id,
      agent_id: row.target_agent_id,
      url: wh.url,
      secret: wh.secret,
      event: row.event,
      payload,
    }))

    await processOutboxRow(row.id, webhookRows)
    outboxProcessed.inc({ outcome: 'delivered', webhook_count: String(webhookRows.length) })
  } catch (err) {
    const errText = err instanceof Error ? err.message : String(err)
    logger.error({ err, outbox_id: row.id, attempts: row.attempts }, 'outbox_row_process_failed')
    outboxProcessed.inc({ outcome: 'failed' })
    await recordOutboxFailure(row.id, errText).catch((innerErr) => {
      logger.error(
        { err: innerErr, outbox_id: row.id },
        'outbox_record_failure_failed',
      )
    })
  }
}

/**
 * Mirror of the `toPublicMessage` helper in message.service.ts. Duplicated
 * deliberately — pulling it out of the service layer into a shared module
 * would force that module to import from outbox-worker's dependency set,
 * and the shape is tiny. If a third call site emerges, centralize.
 */
function toPublicMessage(
  msg: Record<string, unknown>,
  senderHandle: string,
): Record<string, unknown> {
  const {
    sender_id: _sender,
    is_replay: _replay,
    skipped_recipient_ids: _skipped,
    ...rest
  } = msg
  return { ...rest, sender: senderHandle }
}

/**
 * Stable short hash to produce a webhook_deliveries primary key that is
 * deterministic on (outbox_id, webhook_id). SHA-256 truncated to 22 chars
 * of base64url — the same length as generateId's 16-byte random ids, so
 * the two schemes coexist without collision in practice. The `whd` prefix
 * keeps IDs visually distinguishable from other row types in logs.
 */
function deriveDeliveryId(outboxId: string, webhookId: string): string {
  const h = createHash('sha256')
    .update(outboxId)
    .update('\0')
    .update(webhookId)
    .digest('base64url')
    .slice(0, 22)
  return `whd_${h}`
}

// Test-only: synchronously drives one tick and returns when the in-flight
// batch has settled. The production tick runs on an interval and is fire-
// and-forget; tests need the awaitable form so assertions run after the
// DB mocks have actually been called. Underscore prefix mirrors the
// convention used elsewhere (see _resetGroupAggregateAlertStateForTests).
export async function _tickForTests(): Promise<void> {
  tick()
  if (inFlight) await inFlight
}

export { deriveDeliveryId as _deriveDeliveryIdForTests }
