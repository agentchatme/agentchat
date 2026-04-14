import { getSupabaseClient } from '../client.js'

// ─── Events ────────────────────────────────────────────────────────────────
// Append-only security / meta log. Do not duplicate message activity here —
// message activity is derived from messages + message_deliveries at read
// time and merged client-side in the dashboard (see plan §3.1.1, §11.2).

export async function insertEvent(params: {
  id: string
  actor_type: 'owner' | 'agent' | 'system'
  actor_id: string
  action: string
  target_id: string
  metadata?: Record<string, unknown>
}) {
  const { error } = await getSupabaseClient()
    .from('events')
    .insert({
      id: params.id,
      actor_type: params.actor_type,
      actor_id: params.actor_id,
      action: params.action,
      target_id: params.target_id,
      metadata: params.metadata ?? {},
    })

  if (error) throw error
}

/**
 * List events for a given target (usually an agent_id) in reverse
 * chronological order. Cursor is an ISO timestamp — caller passes
 * the `created_at` of the oldest event in the previous page.
 */
export async function listEventsForTarget(
  targetId: string,
  limit = 50,
  beforeCreatedAt?: string,
) {
  let q = getSupabaseClient()
    .from('events')
    .select('*')
    .eq('target_id', targetId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (beforeCreatedAt) {
    q = q.lt('created_at', beforeCreatedAt)
  }

  const { data, error } = await q
  if (error) throw error
  return data ?? []
}

// ─── rotate_api_key_atomic RPC ─────────────────────────────────────────────
// Wraps the SQL function defined in migration 021. Does in one transaction:
//   1. UPDATE agents.api_key_hash
//   2. DELETE any owner_agents row for this agent (capturing owner_id)
//   3. INSERT event 'agent.key_rotated'
//   4. INSERT event 'agent.claim_revoked' IF a claim was actually deleted
//
// Caller pre-generates both event IDs via generateId('evt') so the RPC
// stays deterministic and the caller can log IDs before calling.
// Throws on agent-not-found (PG error code no_data_found).

export async function rotateApiKeyAtomic(params: {
  agent_id: string
  new_hash: string
  rotated_event_id: string
  revoked_event_id: string
}): Promise<void> {
  const { error } = await getSupabaseClient().rpc('rotate_api_key_atomic', {
    p_agent_id: params.agent_id,
    p_new_hash: params.new_hash,
    p_rotated_id: params.rotated_event_id,
    p_revoked_id: params.revoked_event_id,
  })

  if (error) throw error
}
