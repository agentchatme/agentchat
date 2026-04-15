import { getSupabaseClient } from '../client.js'

// --- Contact Book ---

export async function addContact(ownerAgentId: string, contactAgentId: string) {
  const { error } = await getSupabaseClient()
    .from('contacts')
    .upsert({ owner_agent_id: ownerAgentId, contact_agent_id: contactAgentId })
  if (error) throw error
}

export async function removeContact(ownerAgentId: string, contactAgentId: string): Promise<boolean> {
  const { data, error } = await getSupabaseClient()
    .from('contacts')
    .delete()
    .eq('owner_agent_id', ownerAgentId)
    .eq('contact_agent_id', contactAgentId)
    .select('owner_agent_id')
  if (error) throw error
  return (data?.length ?? 0) > 0
}

export async function updateContactNotes(ownerAgentId: string, contactAgentId: string, notes: string | null) {
  const { data, error } = await getSupabaseClient()
    .from('contacts')
    .update({ notes })
    .eq('owner_agent_id', ownerAgentId)
    .eq('contact_agent_id', contactAgentId)
    .select('owner_agent_id')
  if (error) throw error
  return (data?.length ?? 0) > 0
}

export async function listContacts(ownerAgentId: string, limit = 50, offset = 0) {
  // Single JOIN query via RPC — correct total, alphabetical sort, no N+1
  const { data, error } = await getSupabaseClient()
    .rpc('list_contacts_v2', { p_owner_id: ownerAgentId, p_limit: limit, p_offset: offset })

  if (error) throw error
  if (!data || data.length === 0) return { contacts: [], total: 0, limit, offset }

  // Total is repeated on every row from the CTE — take from first row
  const total = Number(data[0].total)

  const contacts = data.map((d: { handle: string; display_name: string | null; description: string | null; notes: string | null; added_at: string }) => ({
    handle: d.handle,
    display_name: d.display_name,
    description: d.description,
    notes: d.notes,
    added_at: d.added_at,
  }))

  return { contacts, total, limit, offset }
}

export async function checkContact(ownerAgentId: string, targetHandle: string) {
  const { data, error } = await getSupabaseClient()
    .rpc('check_contact', { p_owner: ownerAgentId, p_contact_handle: targetHandle })

  if (error) throw error
  if (!data || data.length === 0) return { is_contact: false, added_at: null, notes: null }
  return { is_contact: true, added_at: data[0].added_at, notes: data[0].notes }
}

export async function isContact(ownerAgentId: string, contactAgentId: string): Promise<boolean> {
  const { data } = await getSupabaseClient()
    .from('contacts')
    .select('owner_agent_id')
    .eq('owner_agent_id', ownerAgentId)
    .eq('contact_agent_id', contactAgentId)
    .single()
  return !!data
}

// --- Blocks ---

export async function isBlocked(blockerId: string, blockedId: string) {
  const { data } = await getSupabaseClient()
    .from('blocks')
    .select('blocker_id')
    .eq('blocker_id', blockerId)
    .eq('blocked_id', blockedId)
    .single()
  return !!data
}

export async function isBlockedEither(agentA: string, agentB: string): Promise<boolean> {
  const { data, error } = await getSupabaseClient()
    .rpc('is_blocked_either', { p_agent_a: agentA, p_agent_b: agentB })
  if (error) throw error
  return !!data
}

// Paginated list of every agent this blocker has blocked, enriched
// with handle + display_name so the dashboard block-list view can
// render without a second round-trip per row. Two queries instead of
// a PostgREST embed so we don't couple to FK-relation names — the
// blocks table has two FKs to agents (blocker_id, blocked_id) and
// PostgREST's multi-FK embed hints are brittle to rename. On a
// typical block list (a handful of rows) the extra round-trip is
// negligible.
export async function listBlocks(
  blockerId: string,
  limit = 50,
  offset = 0,
): Promise<{
  blocks: Array<{
    handle: string
    display_name: string | null
    blocked_at: string
  }>
  total: number
  limit: number
  offset: number
}> {
  const supabase = getSupabaseClient()
  const { data: rows, count, error } = await supabase
    .from('blocks')
    .select('blocked_id, created_at', { count: 'exact' })
    .eq('blocker_id', blockerId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (error) throw error
  if (!rows || rows.length === 0) {
    return { blocks: [], total: count ?? 0, limit, offset }
  }

  const blockedIds = rows.map((r) => r.blocked_id as string)
  const { data: agents, error: agentsError } = await supabase
    .from('agents')
    .select('id, handle, display_name, status')
    .in('id', blockedIds)

  if (agentsError) throw agentsError

  // Index by id for O(1) join, preserve blocks ordering (newest first).
  const byId = new Map<
    string,
    { handle: string; display_name: string | null; status: string }
  >()
  for (const a of agents ?? []) {
    byId.set(a.id as string, {
      handle: a.handle as string,
      display_name: (a.display_name as string | null) ?? null,
      status: a.status as string,
    })
  }

  const blocks = rows
    .map((r) => {
      const agent = byId.get(r.blocked_id as string)
      if (!agent) return null
      // Hide soft-deleted agents from the list — the block row stays
      // in the DB for audit, but a deleted handle is meaningless to
      // render.
      if (agent.status === 'deleted') return null
      return {
        handle: agent.handle,
        display_name: agent.display_name,
        blocked_at: r.created_at as string,
      }
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)

  return { blocks, total: count ?? 0, limit, offset }
}

export async function blockAgent(blockerId: string, blockedId: string) {
  const { error } = await getSupabaseClient()
    .from('blocks')
    .upsert({ blocker_id: blockerId, blocked_id: blockedId })
  if (error) throw error
}

export async function unblockAgent(blockerId: string, blockedId: string): Promise<boolean> {
  const { data, error } = await getSupabaseClient()
    .from('blocks')
    .delete()
    .eq('blocker_id', blockerId)
    .eq('blocked_id', blockedId)
    .select('blocker_id')
  if (error) throw error
  return (data?.length ?? 0) > 0
}

// --- Reports ---

export async function hasReported(reporterId: string, reportedId: string): Promise<boolean> {
  const { data } = await getSupabaseClient()
    .from('reports')
    .select('id')
    .eq('reporter_id', reporterId)
    .eq('reported_id', reportedId)
    .single()
  return !!data
}

export async function reportAgent(reporterId: string, reportedId: string, reportId: string, reason?: string) {
  const { error } = await getSupabaseClient()
    .from('reports')
    .insert({
      id: reportId,
      reporter_id: reporterId,
      reported_id: reportedId,
      reason: reason ?? null,
    })
  if (error) throw error
}

// --- Directory ---

export async function searchDirectory(
  query: string,
  limit: number,
  offset: number,
  callerId?: string,
) {
  const { data, error } = await getSupabaseClient()
    .rpc('search_directory', {
      p_query: query,
      p_limit: limit,
      p_offset: offset,
      p_caller_id: callerId ?? null,
    })
  if (error) throw error
  return data ?? []
}

export async function searchDirectoryCount(query: string): Promise<number> {
  const { data, error } = await getSupabaseClient()
    .rpc('search_directory_count', { p_query: query })
  if (error) throw error
  return Number(data ?? 0)
}
