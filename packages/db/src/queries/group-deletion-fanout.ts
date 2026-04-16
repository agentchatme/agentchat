import { getSupabaseClient } from '../client.js'

// ─── Durable group-deletion fan-out queue (migration 030) ─────────────────

export interface GroupDeletionFanoutRow {
  id: string
  group_id: string
  recipient_id: string
  system_msg_id: string
  status: 'pending' | 'delivering' | 'completed' | 'dead'
  attempts: number
  next_attempt_at: string
  last_attempted_at: string | null
  last_error: string | null
  created_at: string
  completed_at: string | null
}

/**
 * Claim up to `limit` rows from the fan-out queue via the SQL function
 * that wraps FOR UPDATE SKIP LOCKED. The rows come back already flipped
 * to 'delivering' with `attempts` incremented; the caller is responsible
 * for finalizing each row by calling markGroupDeletionFanoutCompleted /
 * scheduleGroupDeletionFanoutRetry / markGroupDeletionFanoutDead.
 *
 * Reclaim semantics (60s stale threshold) are enforced inside the RPC —
 * a worker crash mid-tick leaves rows in 'delivering', and the next
 * worker's claim picks them back up after the threshold elapses.
 */
export async function claimGroupDeletionFanout(
  limit: number,
): Promise<GroupDeletionFanoutRow[]> {
  const { data, error } = await getSupabaseClient().rpc(
    'claim_group_deletion_fanout',
    { p_limit: limit },
  )
  if (error) throw error
  return (data ?? []) as GroupDeletionFanoutRow[]
}

/**
 * Mark a fan-out row as successfully delivered. Stamps completed_at so
 * the row stops appearing in the active set without losing the audit
 * trail (we keep completed rows for ops debugging — a future janitor
 * can prune them on age).
 */
export async function markGroupDeletionFanoutCompleted(id: string): Promise<void> {
  const { error } = await getSupabaseClient()
    .from('group_deletion_fanout')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      last_error: null,
    })
    .eq('id', id)
  if (error) throw error
}

/**
 * Reschedule a failed row for a future attempt. Flips status back to
 * 'pending' so the next claim cycle picks it up at next_attempt_at.
 * last_error is truncated to 1024 chars to keep the row size bounded
 * — same cap webhook_deliveries uses.
 */
export async function scheduleGroupDeletionFanoutRetry(
  id: string,
  nextAttemptAt: Date,
  lastError: string,
): Promise<void> {
  const { error } = await getSupabaseClient()
    .from('group_deletion_fanout')
    .update({
      status: 'pending',
      next_attempt_at: nextAttemptAt.toISOString(),
      last_error: lastError.slice(0, 1024),
    })
    .eq('id', id)
  if (error) throw error
}

/**
 * Final state for a row that exhausted its retry budget. The dlq-probe
 * scans for these so persistent dead rows surface as a Sentry alert
 * (separate from individual delivery failures, which are noise).
 */
export async function markGroupDeletionFanoutDead(
  id: string,
  lastError: string,
): Promise<void> {
  const { error } = await getSupabaseClient()
    .from('group_deletion_fanout')
    .update({
      status: 'dead',
      last_error: lastError.slice(0, 1024),
    })
    .eq('id', id)
  if (error) throw error
}

/**
 * Count fan-out rows currently in the dead state, optionally restricted
 * to the last `windowMs` milliseconds. Used by the dlq-probe to drive
 * the agentchat_group_deletion_fanout_dead gauge and the threshold-
 * breach Sentry alert.
 *
 * head:true + count:'exact' returns only the count without streaming
 * row bodies — cheap enough to run on the probe's 5-minute interval.
 */
export async function countDeadGroupDeletionFanout(windowMs?: number): Promise<number> {
  const supabase = getSupabaseClient()
  let query = supabase
    .from('group_deletion_fanout')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'dead')
  if (windowMs !== undefined) {
    const since = new Date(Date.now() - windowMs).toISOString()
    query = query.gte('created_at', since)
  }
  const { count, error } = await query
  if (error) throw error
  return count ?? 0
}
