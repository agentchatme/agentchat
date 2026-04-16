import {
  claimGroupDeletionFanout,
  markGroupDeletionFanoutCompleted,
  scheduleGroupDeletionFanoutRetry,
  markGroupDeletionFanoutDead,
  listFullyPausedAgentIds,
  findGroupById,
  findAgentById,
  getMessageById,
  type GroupDeletionFanoutRow,
} from '@agentchat/db'
import type { DeletedGroupInfo } from '@agentchat/shared'
import {
  groupDeletionFanout,
  groupDeletionFanoutTickSeconds,
} from '../lib/metrics.js'
import { logger } from '../lib/logger.js'
import { Sentry } from '../instrument.js'
import { sendToAgent } from '../ws/events.js'
import { fireWebhooks } from './webhook.service.js'

/**
 * Background worker that drains the group_deletion_fanout queue (migration
 * 030). Each queued row represents "send the live group-deletion notification
 * (message.new + group.deleted, both via WS push and webhook) to one
 * recipient". The queue exists so the work survives the api-server process
 * dying mid-fan-out — the durable side (the system message in messages +
 * message_deliveries) was already handled atomically by delete_group_atomic.
 *
 * Status transitions:
 *   pending      → delivering (done by claim RPC)
 *   delivering   → completed  (WS publish + webhook enqueue both succeed)
 *   delivering   → pending    (retryable failure, attempts < MAX_ATTEMPTS)
 *   delivering   → dead       (failure, attempts >= MAX_ATTEMPTS)
 *
 * Retry schedule: 5s, 30s, 2m, 10m, 30m → ~43min horizon. Tighter than the
 * webhook-delivery schedule (~31h) because:
 *   - The failures we retry here are infra (DB blip, Redis publish blip).
 *     They resolve in seconds-to-minutes, not hours.
 *   - Receiver-side webhook outages are NOT this worker's concern — they're
 *     handled one layer down by webhook_deliveries' own 31h retry horizon.
 *   - A 43min window is still long enough that a worker rolling restart
 *     during the retry path doesn't drop work.
 *
 * Cross-process WS delivery: the worker process holds no WebSocket
 * connections — it publishes through Redis pub/sub (publishToAgent →
 * agentchat:ws:fanout channel) and the api-server processes deliver to
 * their local sockets. Falls back to local-only no-op when REDIS_URL is
 * unset (single-machine dev mode), in which case the WS push is dropped
 * but the system message is still durably visible via /sync — same
 * trade-off as every other ephemeral push in the system.
 */

// Tighter cadence than the webhook worker (1s) because fan-out volume
// after a group delete is bursty: a 10K-member group enqueues 10K rows
// in a single transaction, and we want to drain that within seconds, not
// minutes. With BATCH_SIZE=100, two worker machines process ~200/s
// steady-state — drains a 10K burst in ~50s.
const POLL_INTERVAL_MS = 500
const BATCH_SIZE = 100

// Delays AFTER each failure, in milliseconds. Index N is the wait after
// the Nth failure (delay[0] = after attempt 1). Length = 5; attempt 6 is
// the last. Total horizon = 5 + 30 + 120 + 600 + 1800 = ~43 minutes.
const RETRY_DELAYS_MS = [
  5_000, // 5s
  30_000, // 30s
  120_000, // 2m
  600_000, // 10m
  1_800_000, // 30m
] as const

const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1 // initial + 5 retries = 6

// Jitter window applied to each retry delay. Without jitter, a transient
// outage that bounces 100 rows into 'pending' at the same instant would
// see them all wake up together, retry together, and re-fail together —
// classic thundering herd. ±20% spread gives the dependent system breathing
// room. Pulled from a uniform distribution; not cryptographically random
// (Math.random is fine for jitter).
const JITTER_RATIO = 0.2

let pollTimer: NodeJS.Timeout | null = null
let stopped = false
// Track the in-flight tick so graceful shutdown waits for it to settle
// before tearing down DB connections — same pattern as webhook-worker.
let inFlight: Promise<void> | null = null

export function startGroupDeletionFanoutWorker() {
  if (pollTimer) return
  stopped = false
  pollTimer = setInterval(() => {
    void tick()
  }, POLL_INTERVAL_MS)
  // Immediate tick so a startup with backlog rows doesn't wait
  // POLL_INTERVAL_MS for the first poll.
  void tick()
  logger.info(
    { poll_ms: POLL_INTERVAL_MS, batch_size: BATCH_SIZE, max_attempts: MAX_ATTEMPTS },
    'group_deletion_fanout_worker_started',
  )
}

/** Stop polling and wait for the current tick (if any) to settle. Mirrors
 *  stopWebhookWorker — SIGTERM handlers want to sequence DB shutdown after
 *  this so an in-flight claim → publish → mark cycle isn't torn out from
 *  under itself. */
export async function stopGroupDeletionFanoutWorker(): Promise<void> {
  stopped = true
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (inFlight) {
    try {
      await inFlight
    } catch {
      // tick() catches its own errors; ignore abnormal settle.
    }
  }
  logger.info('group_deletion_fanout_worker_stopped')
}

function tick(): void {
  if (inFlight || stopped) return
  inFlight = (async () => {
    const tickStart = Date.now()
    try {
      const rows = await claimGroupDeletionFanout(BATCH_SIZE)
      if (rows.length === 0) return

      // Most rows in a batch share the same group_id (a single delete
      // produces N recipients). Load the per-group payload context once
      // per unique group rather than once per row — at 10K-member groups
      // this is the difference between 1 and 10K extra Postgres lookups.
      const ctxByGroup = await loadGroupContexts(rows)

      // Pause check is also a single batched query for the whole tick.
      // listFullyPausedAgentIds returns a Set; per-row check is O(1).
      const recipientIds = rows.map((r) => r.recipient_id)
      const fullyPaused = await listFullyPausedAgentIds(recipientIds)

      // Process all claimed rows in parallel — each row is independent
      // and the slowest legs (publishToAgent, fireWebhooks) are I/O-bound.
      // Settle so one failed row can't block the whole batch from finalizing.
      await Promise.allSettled(
        rows.map((row) => processRow(row, ctxByGroup, fullyPaused)),
      )
    } catch (err) {
      // Tick-level failure (claim RPC down, DB unreachable). The next tick
      // retries; rows we managed to claim before the throw stay in
      // 'delivering' and get reclaimed after the 60s stale window.
      logger.error({ err }, 'group_deletion_fanout_tick_failed')
      Sentry.captureException(err, {
        tags: { component: 'group-deletion-fanout-worker' },
      })
    } finally {
      groupDeletionFanoutTickSeconds.observe((Date.now() - tickStart) / 1000)
      inFlight = null
    }
  })()
}

interface GroupContext {
  /** The fan-out payloads for both events, keyed by group. Built once per
   *  unique group_id in the batch. null if the group/message/actor row
   *  has been hard-deleted between enqueue and drain (extremely rare —
   *  group_deletion_fanout has FK ON DELETE CASCADE on all three) */
  systemMessagePayload: Record<string, unknown>
  deletedPayload: DeletedGroupInfo
}

async function loadGroupContexts(
  rows: GroupDeletionFanoutRow[],
): Promise<Map<string, GroupContext | null>> {
  // Dedupe (group_id, system_msg_id) pairs — rows from the same delete
  // share both, so we look up exactly once per delete.
  const uniquePairs = new Map<string, { groupId: string; systemMsgId: string }>()
  for (const row of rows) {
    const key = `${row.group_id}::${row.system_msg_id}`
    if (!uniquePairs.has(key)) {
      uniquePairs.set(key, { groupId: row.group_id, systemMsgId: row.system_msg_id })
    }
  }

  const out = new Map<string, GroupContext | null>()
  await Promise.all(
    Array.from(uniquePairs.values()).map(async ({ groupId, systemMsgId }) => {
      const ctx = await loadOneGroupContext(groupId, systemMsgId)
      out.set(`${groupId}::${systemMsgId}`, ctx)
    }),
  )
  return out
}

async function loadOneGroupContext(
  groupId: string,
  systemMsgId: string,
): Promise<GroupContext | null> {
  const [group, message] = await Promise.all([
    findGroupById(groupId),
    getMessageById(systemMsgId),
  ])
  if (!group || !message) return null

  const deletedById = group.deleted_by as string | null
  // The actor handle is the human-readable identity for the WS / webhook
  // payload. It can drift if the actor renames between delete and drain
  // — we accept that drift and use the current value, same convention as
  // every other group system event (which also re-derives at fan-out).
  let actorHandle = 'unknown'
  if (deletedById) {
    const actor = await findAgentById(deletedById)
    if (actor) actorHandle = actor.handle
  }

  // Mirror the payload shape the api-server's deleteGroup used to build
  // inline. Wire shape is the contract — keeping it identical ensures
  // SDK consumers see no behavior change after this refactor.
  const systemMessagePayload = {
    id: message.id as string,
    conversation_id: groupId,
    sender: actorHandle,
    client_msg_id: message.client_msg_id as string,
    seq: message.seq as number,
    type: 'system' as const,
    content: message.content as Record<string, unknown>,
    metadata: (message.metadata as Record<string, unknown>) ?? {},
    created_at: message.created_at as string,
  }

  const deletedPayload: DeletedGroupInfo = {
    group_id: groupId,
    deleted_by_handle: actorHandle,
    deleted_at: group.deleted_at as string,
  }

  return { systemMessagePayload, deletedPayload }
}

async function processRow(
  row: GroupDeletionFanoutRow,
  ctxByGroup: Map<string, GroupContext | null>,
  fullyPaused: Set<string>,
) {
  const ctx = ctxByGroup.get(`${row.group_id}::${row.system_msg_id}`)
  if (!ctx) {
    // Group / message gone (cascaded delete or manual cleanup). Nothing
    // to fan out — mark completed so we don't keep retrying. Logged as a
    // warning because this should be vanishingly rare in production and
    // hints at an inconsistency worth a human look.
    logger.warn(
      { fanout_id: row.id, group_id: row.group_id, system_msg_id: row.system_msg_id },
      'group_deletion_fanout_context_missing',
    )
    await markGroupDeletionFanoutCompleted(row.id).catch((err) => {
      logger.error({ err, fanout_id: row.id }, 'group_deletion_fanout_mark_completed_failed')
    })
    return
  }

  // Pause check: a recipient who's been "fully paused" by their owner is
  // not receiving live pushes (matches the message.new pause behavior in
  // message.service.ts). The system message stays durable — they pick it
  // up via /sync once unpaused. Mark the row completed so we don't retry
  // it forever; this is a logical success, not a failure.
  if (fullyPaused.has(row.recipient_id)) {
    groupDeletionFanout.inc({ outcome: 'paused' })
    await markGroupDeletionFanoutCompleted(row.id).catch((err) => {
      logger.error({ err, fanout_id: row.id }, 'group_deletion_fanout_mark_completed_failed')
    })
    return
  }

  try {
    // WS push is fire-and-forget through Redis pub/sub — publishToAgent
    // returns void. Failures inside publishToAgent are caught there and
    // fall back to local delivery, which is a no-op in the worker
    // process. The webhook enqueue below is the load-bearing durable side.
    sendToAgent(row.recipient_id, {
      type: 'message.new',
      payload: ctx.systemMessagePayload,
    })
    sendToAgent(row.recipient_id, {
      type: 'group.deleted',
      payload: ctx.deletedPayload as unknown as Record<string, unknown>,
    })

    // Webhook enqueue is the call that can actually throw (DB INSERT into
    // webhook_deliveries). Both events are awaited in parallel — neither
    // is more important than the other and a partial failure means we
    // retry the whole row, which is acceptable: webhook_deliveries has
    // unique constraints that absorb the duplicate enqueue attempt on
    // the second try.
    await Promise.all([
      fireWebhooks(row.recipient_id, 'message.new', ctx.systemMessagePayload),
      fireWebhooks(
        row.recipient_id,
        'group.deleted',
        ctx.deletedPayload as unknown as Record<string, unknown>,
      ),
    ])

    await markGroupDeletionFanoutCompleted(row.id)
    groupDeletionFanout.inc({ outcome: 'delivered' })
  } catch (err) {
    const errText = err instanceof Error ? err.message : String(err)
    await scheduleNextAttempt(row, errText)
  }
}

async function scheduleNextAttempt(row: GroupDeletionFanoutRow, errText: string) {
  // attempts was incremented by the claim RPC, so it reflects the attempt
  // that just failed. attempts === MAX_ATTEMPTS means we've exhausted the
  // schedule and this row is dead.
  if (row.attempts >= MAX_ATTEMPTS) {
    groupDeletionFanout.inc({ outcome: 'dead' })
    await markGroupDeletionFanoutDead(row.id, errText).catch((err) => {
      logger.error(
        { err, fanout_id: row.id },
        'group_deletion_fanout_mark_dead_failed',
      )
    })
    // Surface to Sentry — a dead row is a per-recipient lost notification,
    // worth a human look even though the durable system message is still
    // intact via /sync.
    Sentry.captureMessage('group_deletion_fanout_dead', {
      level: 'warning',
      tags: { component: 'group-deletion-fanout-worker' },
      extra: {
        fanout_id: row.id,
        group_id: row.group_id,
        recipient_id: row.recipient_id,
        attempts: row.attempts,
        last_error: errText.slice(0, 256),
      },
    })
    return
  }

  groupDeletionFanout.inc({ outcome: 'failed' })
  const baseDelay =
    RETRY_DELAYS_MS[row.attempts - 1] ??
    RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!
  const jitter = baseDelay * JITTER_RATIO * (Math.random() * 2 - 1)
  const delayMs = Math.max(0, baseDelay + jitter)
  const nextAt = new Date(Date.now() + delayMs)
  await scheduleGroupDeletionFanoutRetry(row.id, nextAt, errText).catch((err) => {
    logger.error(
      { err, fanout_id: row.id },
      'group_deletion_fanout_schedule_retry_failed',
    )
  })
}
