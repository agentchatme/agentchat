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
 */
export async function claimWebhookDeliveries(
  limit: number,
): Promise<WebhookDeliveryRow[]> {
  const { data, error } = await getSupabaseClient().rpc('claim_webhook_deliveries', {
    p_limit: limit,
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
