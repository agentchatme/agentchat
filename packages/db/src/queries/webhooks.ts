import { getSupabaseClient } from '../client.js'

export async function createWebhook(webhook: {
  id: string
  agent_id: string
  url: string
  events: string[]
  secret: string
}) {
  const { data, error } = await getSupabaseClient()
    .from('webhooks')
    .insert(webhook)
    .select()
    .single()

  if (error) throw error
  return data
}

export async function getWebhooksByAgent(agentId: string) {
  const { data, error } = await getSupabaseClient()
    .from('webhooks')
    .select('*')
    .eq('agent_id', agentId)
    .eq('active', true)

  if (error) throw error
  return data ?? []
}

export async function getWebhookById(id: string) {
  const { data, error } = await getSupabaseClient()
    .from('webhooks')
    .select('*')
    .eq('id', id)
    .single()

  if (error) throw error
  return data
}

export async function deleteWebhook(id: string, agentId: string) {
  const { error } = await getSupabaseClient()
    .from('webhooks')
    .delete()
    .eq('id', id)
    .eq('agent_id', agentId)

  if (error) throw error
}

export async function getWebhooksForEvent(agentId: string, event: string) {
  const { data, error } = await getSupabaseClient()
    .from('webhooks')
    .select('*')
    .eq('agent_id', agentId)
    .eq('active', true)
    .contains('events', [event])

  if (error) throw error
  return data ?? []
}

// ─── Webhook delivery queue (migration 012) ────────────────────────────────

export interface WebhookDeliveryRow {
  id: string
  webhook_id: string
  agent_id: string
  url: string
  secret: string
  event: string
  payload: Record<string, unknown>
  status: 'pending' | 'delivering' | 'delivered' | 'failed' | 'dead'
  attempts: number
  next_attempt_at: string
  last_attempted_at: string | null
  last_error: string | null
  created_at: string
  delivered_at: string | null
}

/**
 * Enqueue a webhook delivery for the background worker to pick up.
 * Returns the inserted row id so the caller can log / correlate it.
 */
export async function enqueueWebhookDelivery(row: {
  id: string
  webhook_id: string
  agent_id: string
  url: string
  secret: string
  event: string
  payload: Record<string, unknown>
}): Promise<void> {
  const { error } = await getSupabaseClient()
    .from('webhook_deliveries')
    .insert(row)

  if (error) throw error
}

/**
 * Claim up to `limit` pending/failed rows (or stale delivering rows) via
 * the SQL function that wraps FOR UPDATE SKIP LOCKED. Returns the claimed
 * rows with status already flipped to 'delivering' and attempts incremented.
 * The caller is expected to finalize each row by calling
 * markWebhookDelivered / scheduleWebhookRetry / markWebhookDead.
 *
 * `excludeWebhookIds` (§3.4.3) skips rows whose webhook_id is currently
 * behind an open circuit breaker — those rows stay 'pending' with their
 * attempts counter untouched, so the ~31h retry horizon is preserved
 * across circuit-open windows.
 */
export async function claimWebhookDeliveries(
  limit: number,
  excludeWebhookIds: readonly string[] = [],
): Promise<WebhookDeliveryRow[]> {
  const { data, error } = await getSupabaseClient().rpc('claim_webhook_deliveries', {
    p_limit: limit,
    p_exclude_webhook_ids: excludeWebhookIds.length > 0 ? [...excludeWebhookIds] : null,
  })
  if (error) throw error
  return (data ?? []) as WebhookDeliveryRow[]
}

export async function markWebhookDelivered(id: string): Promise<void> {
  const { error } = await getSupabaseClient()
    .from('webhook_deliveries')
    .update({
      status: 'delivered',
      delivered_at: new Date().toISOString(),
      last_error: null,
    })
    .eq('id', id)
  if (error) throw error
}

export async function scheduleWebhookRetry(
  id: string,
  nextAttemptAt: Date,
  lastError: string,
): Promise<void> {
  const { error } = await getSupabaseClient()
    .from('webhook_deliveries')
    .update({
      status: 'failed',
      next_attempt_at: nextAttemptAt.toISOString(),
      last_error: lastError.slice(0, 1024),
    })
    .eq('id', id)
  if (error) throw error
}

/**
 * @deprecated Kept for backward compat with any call site that hasn't moved
 * to moveWebhookToDlq yet. New code should call moveWebhookToDlq which
 * atomically transitions the row into `webhook_deliveries_dlq`.
 *
 * This shim now routes through the DLQ function so the behavior is
 * identical to moveWebhookToDlq — the row leaves webhook_deliveries for
 * the DLQ table. The name is misleading (nothing gets a 'dead' status
 * anymore) but removing it would be a churn-for-churn rename.
 */
export async function markWebhookDead(id: string, lastError: string): Promise<void> {
  await moveWebhookToDlq(id, lastError)
}

/**
 * Transition an exhausted delivery into the dedicated DLQ table (migration
 * 032). Called by webhook-worker.ts:scheduleNextAttempt once a row's
 * attempts counter hits MAX_ATTEMPTS. Atomic INSERT DLQ + DELETE
 * webhook_deliveries inside the SQL function, so a crash mid-call leaves
 * the row in a consistent state.
 */
export async function moveWebhookToDlq(id: string, lastError: string): Promise<void> {
  const { error } = await getSupabaseClient().rpc('move_to_dlq', {
    p_delivery_id: id,
    p_last_error: lastError.slice(0, 1024),
  })
  if (error) throw error
}

/**
 * Operator-facing replay. Re-enqueues a DLQ row as a fresh
 * webhook_deliveries row (attempts=0, next_attempt_at=NOW, status=pending)
 * and stamps `replayed_at` + `replayed_as_id` on the original DLQ row.
 * Returns the new delivery id.
 */
export async function replayWebhookDlq(dlqId: string): Promise<string> {
  const newId = `whd_replay_${Math.random().toString(36).slice(2, 14)}`
  const { data, error } = await getSupabaseClient().rpc('replay_webhook_dlq', {
    p_dlq_id: dlqId,
    p_new_id: newId,
  })
  if (error) throw error
  return (data as string | null) ?? newId
}

/**
 * Count DLQ rows that landed within the last `windowMs` milliseconds and
 * haven't been replayed yet. Used by the worker's DLQ-health probe — fed
 * into the `agentchat_webhook_deliveries_dead` gauge and compared against
 * a threshold to fire a Sentry alert when DLQ growth points at a systemic
 * delivery problem rather than a single bad receiver.
 *
 * Source switched from `webhook_deliveries WHERE status='dead'` to
 * `webhook_deliveries_dlq WHERE replayed_at IS NULL` by migration 032. The
 * function name is unchanged to keep the dlq-probe call-site stable.
 */
export async function countDeadWebhookDeliveries(windowMs: number): Promise<number> {
  const since = new Date(Date.now() - windowMs).toISOString()
  const { count, error } = await getSupabaseClient()
    .from('webhook_deliveries_dlq')
    .select('id', { count: 'exact', head: true })
    .is('replayed_at', null)
    .gte('dead_at', since)
  if (error) throw error
  return count ?? 0
}

/**
 * Row shape returned by listWebhookDlq for dashboards / CLI tools. Omits
 * the secret — operators shouldn't need the shared signing secret to
 * decide whether to replay, and leaking it wider than necessary is a
 * bad default.
 */
export interface WebhookDlqRow {
  id: string
  webhook_id: string | null
  agent_id: string
  url: string
  event: string
  payload: Record<string, unknown>
  attempts: number
  last_error: string | null
  first_attempted_at: string | null
  last_attempted_at: string
  dead_at: string
  replayed_at: string | null
  replayed_as_id: string | null
}

/**
 * Paginated list of DLQ rows for an agent. Ordered by dead_at DESC so the
 * most recent failures surface first — consistent with how the dashboard
 * webhook-delivery list orders in-flight rows.
 */
export async function listWebhookDlq(
  agentId: string,
  limit = 50,
): Promise<WebhookDlqRow[]> {
  const { data, error } = await getSupabaseClient()
    .from('webhook_deliveries_dlq')
    .select('id, webhook_id, agent_id, url, event, payload, attempts, last_error, first_attempted_at, last_attempted_at, dead_at, replayed_at, replayed_as_id')
    .eq('agent_id', agentId)
    .order('dead_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data ?? []) as WebhookDlqRow[]
}

/**
 * Measure drift between the cached `agents.undelivered_count` (maintained
 * by the bump/drop triggers in migrations 025/027) and the authoritative
 * count of `message_deliveries` rows currently in `status='stored'`.
 *
 * The two should always be equal. A persistent non-zero drift means a
 * code path bumped or transitioned an envelope without going through the
 * trigger (manual UPDATE, partition skew, a future migration that forgot
 * the trigger DDL). The dlq-probe scrapes this on its 5-minute tick so
 * the drift gauge in metrics shows up on Grafana without a separate cron.
 *
 * Two independent parallel queries — at the gauge cadence (5 minutes)
 * the inter-query race window is irrelevant; we're watching for
 * sustained deltas in the hundreds-to-millions range, not single-row
 * jitter. count:'exact' + head:true skips body streaming on both.
 */
export async function measureUndeliveredDrift(): Promise<{
  counterSum: number
  actualCount: number
}> {
  const supabase = getSupabaseClient()
  const [sumRes, countRes] = await Promise.all([
    supabase.rpc('sum_undelivered_count'),
    supabase
      .from('message_deliveries')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'stored'),
  ])
  if (sumRes.error) throw sumRes.error
  if (countRes.error) throw countRes.error
  const counterSum =
    typeof sumRes.data === 'number' ? sumRes.data : Number(sumRes.data ?? 0)
  return {
    counterSum: Number.isFinite(counterSum) ? counterSum : 0,
    actualCount: countRes.count ?? 0,
  }
}
