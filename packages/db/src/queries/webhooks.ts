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

export async function markWebhookDead(id: string, lastError: string): Promise<void> {
  const { error } = await getSupabaseClient()
    .from('webhook_deliveries')
    .update({
      status: 'dead',
      last_error: lastError.slice(0, 1024),
    })
    .eq('id', id)
  if (error) throw error
}

/**
 * Count webhook_deliveries in the dead-letter queue (status='dead') that
 * landed there within the last `windowMs` milliseconds. Used by the worker's
 * DLQ-health probe — fed into the `agentchat_webhook_deliveries_dead` gauge
 * for scrapers, and compared against a threshold to fire a Sentry alert when
 * dead-letter growth points at a systemic delivery problem rather than a
 * single bad receiver.
 *
 * Uses head:true + count:'exact' so PostgREST returns only the count without
 * streaming row bodies — cheap enough to run on a 5-minute interval.
 */
export async function countDeadWebhookDeliveries(windowMs: number): Promise<number> {
  const since = new Date(Date.now() - windowMs).toISOString()
  const { count, error } = await getSupabaseClient()
    .from('webhook_deliveries')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'dead')
    .gte('created_at', since)
  if (error) throw error
  return count ?? 0
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
