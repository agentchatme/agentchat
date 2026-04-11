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
