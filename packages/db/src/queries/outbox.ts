import { getSupabaseClient } from '../client.js'

// ─── Message outbox (migration 031) ────────────────────────────────────────

/**
 * Outbox row claimed from the `message_outbox` queue. The worker processes
 * each of these by:
 *   1. Loading the message body + sender handle
 *   2. Loading the target agent's webhook subscriptions for `event`
 *   3. Composing a webhook_deliveries row per subscription
 *   4. Calling `process_outbox_row` to atomically persist them and delete
 *      this outbox row
 *
 * `attempts` is already incremented by claim_message_outbox — the row you
 * receive has the post-claim count, not the pre-claim count.
 */
export interface MessageOutboxRow {
  id: string
  message_id: string
  conversation_id: string
  target_agent_id: string
  event: string
  attempts: number
}

/**
 * Claim up to `limit` unprocessed rows from message_outbox. Delegates to the
 * SQL function that wraps FOR UPDATE SKIP LOCKED + stale-claim reclaim, so
 * multiple worker processes can poll concurrently without fighting over
 * rows.
 *
 * Rows returned here are in claim state — the worker MUST either call
 * `processOutboxRow` (happy path: persists webhook_deliveries and deletes
 * the outbox row) or `recordOutboxFailure` (error path: releases the claim
 * with an error message so the next tick can retry). A worker crash in
 * between will leave the row in claim state, and the next claim cycle
 * reclaims it after 60s — see claim_message_outbox in migration 031.
 */
export async function claimMessageOutbox(
  limit: number,
): Promise<MessageOutboxRow[]> {
  const { data, error } = await getSupabaseClient().rpc('claim_message_outbox', {
    p_limit: limit,
  })
  if (error) throw error
  return (data ?? []) as MessageOutboxRow[]
}

/**
 * Shape of each element in the `p_webhook_rows` JSONB array passed to
 * process_outbox_row. The `id` is derived deterministically from
 * (outbox_id, webhook_id) so a reclaim-race double-process collapses at the
 * webhook_deliveries primary key (ON CONFLICT DO NOTHING).
 */
export interface OutboxWebhookInsert {
  id: string
  webhook_id: string
  agent_id: string
  url: string
  secret: string
  event: string
  payload: Record<string, unknown>
}

/**
 * Atomically:
 *   - INSERT each row in `webhookRows` into webhook_deliveries (ON CONFLICT
 *     DO NOTHING on the primary key so replays are safe)
 *   - DELETE the outbox row by id
 *
 * Either both happen or neither does. Pass an empty array when the target
 * has no webhooks for this event — the outbox row still deletes cleanly
 * (there's just nothing to persist downstream).
 */
export async function processOutboxRow(
  outboxId: string,
  webhookRows: readonly OutboxWebhookInsert[],
): Promise<void> {
  const { error } = await getSupabaseClient().rpc('process_outbox_row', {
    p_outbox_id: outboxId,
    p_webhook_rows: webhookRows as unknown as Record<string, unknown>[],
  })
  if (error) throw error
}

/**
 * Release the claim on a row that couldn't be processed. The row stays in
 * the queue with `claimed_at = NULL` so the next claim cycle picks it up.
 * `error` is truncated to 1024 chars inside the caller (matching the
 * webhook_deliveries convention); we don't re-truncate here because the
 * worker already bounds the message.
 */
export async function recordOutboxFailure(
  outboxId: string,
  errorMessage: string,
): Promise<void> {
  const { error } = await getSupabaseClient().rpc('record_outbox_failure', {
    p_outbox_id: outboxId,
    p_error: errorMessage.slice(0, 1024),
  })
  if (error) throw error
}

/**
 * Batch-load messages by id for the outbox worker. The outbox row only
 * carries a message_id reference; the worker joins to the body so it can
 * compose the webhook payload (which is the full public message shape).
 * Unknown ids are silently dropped — the caller keys on the returned Map
 * and any outbox row whose message is missing (partition aged out, manual
 * delete) gets a distinctive error path.
 */
export async function getMessagesByIds(
  ids: readonly string[],
): Promise<Map<string, Record<string, unknown>>> {
  if (ids.length === 0) return new Map()
  const { data, error } = await getSupabaseClient()
    .from('messages')
    .select('*')
    .in('id', ids as string[])
  if (error) throw error
  const out = new Map<string, Record<string, unknown>>()
  for (const row of data ?? []) {
    out.set(row.id as string, row as Record<string, unknown>)
  }
  return out
}

/**
 * Batch-load webhook subscriptions for a list of (agent_id, event) pairs.
 * Returns a Map keyed on agent_id where the value is the list of active
 * subscriptions that include `event`. Agents with no matching subscription
 * are absent from the map — the worker treats that as "nothing to persist"
 * and still deletes the outbox row.
 *
 * We fetch all active rows for the given agents in one query, then
 * filter by event in memory. This keeps the wire hit to O(1) rather than
 * O(unique-agents) round-trips — critical when a large group message
 * produces hundreds of outbox rows inside a single worker tick.
 */
export async function getWebhooksForAgentsAndEvent(
  agentIds: readonly string[],
  event: string,
): Promise<Map<string, Array<{ id: string; url: string; secret: string; events: string[] }>>> {
  if (agentIds.length === 0) return new Map()
  const { data, error } = await getSupabaseClient()
    .from('webhooks')
    .select('id, agent_id, url, secret, events')
    .in('agent_id', agentIds as string[])
    .eq('active', true)
  if (error) throw error
  const out = new Map<
    string,
    Array<{ id: string; url: string; secret: string; events: string[] }>
  >()
  for (const row of data ?? []) {
    const events = (row.events as string[]) ?? []
    if (!events.includes(event)) continue
    const list = out.get(row.agent_id as string) ?? []
    list.push({
      id: row.id as string,
      url: row.url as string,
      secret: row.secret as string,
      events,
    })
    out.set(row.agent_id as string, list)
  }
  return out
}

/**
 * Count outbox rows older than `maxAgeMs`. Used by the dlq-probe so the
 * agentchat_message_outbox_lag gauge surfaces queue build-up (worker
 * stuck, DB contention). Legit steady state is a handful of rows that
 * live for <1 second each — anything with meaningful lag is an incident.
 */
export async function countStaleOutboxRows(maxAgeMs: number): Promise<number> {
  const olderThan = new Date(Date.now() - maxAgeMs).toISOString()
  const { count, error } = await getSupabaseClient()
    .from('message_outbox')
    .select('id', { count: 'exact', head: true })
    .lte('created_at', olderThan)
  if (error) throw error
  return count ?? 0
}
