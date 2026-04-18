import { getSupabaseClient } from '../client.js'

// ─── Support escalations (migration 041) ───────────────────────────────────
//
// Rows are written by chatfather (apps/chatfather/src/escalation.ts) and
// drained by ops through POST /internal endpoints in api-server. These
// helpers are the read/update side of that pipeline — the write side
// lives inside chatfather because it owns the categorization logic.
//
// Not exporting a "create" helper from here on purpose: a support agent's
// message flow should only insert rows on its own schema-backed path, not
// accept platform-admin writes from anywhere that imports @agentchat/db.

export type SupportEscalationStatus =
  | 'open'
  | 'in_progress'
  | 'resolved'
  | 'discarded'

export type SupportEscalationCategory = 'bug' | 'feature' | 'abuse' | 'other'

export interface SupportEscalationRow {
  id: string
  from_agent_handle: string
  conversation_id: string
  original_message_id: string
  category: SupportEscalationCategory
  summary: string
  status: SupportEscalationStatus
  created_at: string
  resolved_at: string | null
  resolved_by: string | null
  resolution_note: string | null
}

/**
 * List escalations in reverse chronological order. When `status` is
 * omitted, returns the live working set (open + in_progress) so the
 * default read hits the partial index — passing no filter should NOT
 * page through resolved history.
 */
export async function listSupportEscalations(params: {
  status?: SupportEscalationStatus | 'live'
  limit?: number
  beforeCreatedAt?: string
}): Promise<SupportEscalationRow[]> {
  const limit = params.limit ?? 50
  const statusFilter = params.status ?? 'live'

  let q = getSupabaseClient()
    .from('support_escalations')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (statusFilter === 'live') {
    q = q.in('status', ['open', 'in_progress'])
  } else {
    q = q.eq('status', statusFilter)
  }

  if (params.beforeCreatedAt) {
    q = q.lt('created_at', params.beforeCreatedAt)
  }

  const { data, error } = await q
  if (error) throw error
  return (data ?? []) as SupportEscalationRow[]
}

/**
 * Ops-side status transition. resolution_note is only meaningful on
 * terminal statuses (resolved, discarded); the caller is responsible
 * for passing it when those apply. resolved_at is stamped server-side
 * on any transition out of open/in_progress.
 */
export async function updateSupportEscalationStatus(params: {
  id: string
  status: SupportEscalationStatus
  resolvedBy: string
  resolutionNote?: string
}): Promise<SupportEscalationRow | null> {
  const patch: Record<string, unknown> = {
    status: params.status,
    resolved_by: params.resolvedBy,
  }
  const terminal = params.status === 'resolved' || params.status === 'discarded'
  if (terminal) {
    patch.resolved_at = new Date().toISOString()
    if (params.resolutionNote !== undefined) {
      patch.resolution_note = params.resolutionNote
    }
  } else {
    // Moving back to open / in_progress clears any prior resolution so
    // a reopened ticket doesn't carry a stale "resolved by X" marker.
    patch.resolved_at = null
    patch.resolution_note = null
  }

  const { data, error } = await getSupabaseClient()
    .from('support_escalations')
    .update(patch)
    .eq('id', params.id)
    .select('*')
    .maybeSingle()

  if (error) throw error
  return (data ?? null) as SupportEscalationRow | null
}
