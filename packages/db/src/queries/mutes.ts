import { getSupabaseClient } from '../client.js'

export type MuteTargetKind = 'agent' | 'conversation'

export interface MuteRow {
  muter_agent_id: string
  target_kind: MuteTargetKind
  target_id: string
  muted_until: string | null
  created_at: string
}

/**
 * Upsert a mute. Idempotent on (muter, kind, target_id): a repeat call
 * with a new muted_until updates the existing row rather than erroring,
 * matching the UX of "mute this again for 8 more hours."
 */
export async function createMute(row: {
  muter_agent_id: string
  target_kind: MuteTargetKind
  target_id: string
  muted_until: string | null
}): Promise<MuteRow> {
  const { data, error } = await getSupabaseClient()
    .from('mutes')
    .upsert(row, { onConflict: 'muter_agent_id,target_kind,target_id' })
    .select()
    .single()
  if (error) throw error
  return data as MuteRow
}

/**
 * Remove a mute. Returns true if a row was deleted, false if none
 * existed — the caller decides whether that's a 404 or a 200.
 */
export async function removeMute(
  muterAgentId: string,
  targetKind: MuteTargetKind,
  targetId: string,
): Promise<boolean> {
  const { count, error } = await getSupabaseClient()
    .from('mutes')
    .delete({ count: 'exact' })
    .eq('muter_agent_id', muterAgentId)
    .eq('target_kind', targetKind)
    .eq('target_id', targetId)
  if (error) throw error
  return (count ?? 0) > 0
}

/**
 * List all mutes owned by a muter. Expired rows (muted_until in the
 * past) are filtered out server-side — they're dead weight and would
 * confuse the UI. A separate cleanup can GC them; the send-path query
 * already ignores them.
 */
export async function listMutes(
  muterAgentId: string,
  opts: { kind?: MuteTargetKind } = {},
): Promise<MuteRow[]> {
  let q = getSupabaseClient()
    .from('mutes')
    .select('*')
    .eq('muter_agent_id', muterAgentId)
    .or('muted_until.is.null,muted_until.gt.' + new Date().toISOString())
    .order('created_at', { ascending: false })
  if (opts.kind) q = q.eq('target_kind', opts.kind)
  const { data, error } = await q
  if (error) throw error
  return (data ?? []) as MuteRow[]
}

/**
 * Single-target lookup. Returns null if not muted or if the mute has
 * expired. Used by route handlers to check idempotency / return state
 * without a full list fetch.
 */
export async function getMuteStatus(
  muterAgentId: string,
  targetKind: MuteTargetKind,
  targetId: string,
): Promise<MuteRow | null> {
  const { data, error } = await getSupabaseClient()
    .from('mutes')
    .select('*')
    .eq('muter_agent_id', muterAgentId)
    .eq('target_kind', targetKind)
    .eq('target_id', targetId)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  if (data.muted_until && new Date(data.muted_until) <= new Date()) return null
  return data as MuteRow
}

/**
 * Batch "which conversation ids are muted by this agent" — used by
 * /v1/conversations to stamp is_muted on the list response without a
 * per-row subquery. Only active conversation-kind mutes are returned.
 */
export async function listMutedConversationIds(
  muterAgentId: string,
): Promise<string[]> {
  const { data, error } = await getSupabaseClient()
    .from('mutes')
    .select('target_id')
    .eq('muter_agent_id', muterAgentId)
    .eq('target_kind', 'conversation')
    .or('muted_until.is.null,muted_until.gt.' + new Date().toISOString())
  if (error) throw error
  return (data ?? []).map((r) => r.target_id as string)
}

/**
 * Batch "which of these agent ids does the muter have a mute on" —
 * lets /v1/conversations also flag DM rows where the other party is
 * agent-muted. Returns the subset of input ids the muter has actively
 * muted (kind='agent').
 */
export async function listMutedAgentIds(
  muterAgentId: string,
  candidateAgentIds: readonly string[],
): Promise<Set<string>> {
  if (candidateAgentIds.length === 0) return new Set()
  const { data, error } = await getSupabaseClient()
    .from('mutes')
    .select('target_id')
    .eq('muter_agent_id', muterAgentId)
    .eq('target_kind', 'agent')
    .in('target_id', [...candidateAgentIds])
    .or('muted_until.is.null,muted_until.gt.' + new Date().toISOString())
  if (error) throw error
  return new Set((data ?? []).map((r) => r.target_id as string))
}
