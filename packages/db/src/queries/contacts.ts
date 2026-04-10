import { getSupabaseClient } from '../client.js'

// --- Contact Book ---

export async function addContact(ownerAgentId: string, contactAgentId: string) {
  const { error } = await getSupabaseClient()
    .from('contacts')
    .upsert({ owner_agent_id: ownerAgentId, contact_agent_id: contactAgentId })
  if (error) throw error
}

export async function removeContact(ownerAgentId: string, contactAgentId: string) {
  const { error } = await getSupabaseClient()
    .from('contacts')
    .delete()
    .eq('owner_agent_id', ownerAgentId)
    .eq('contact_agent_id', contactAgentId)
  if (error) throw error
}

export async function listContacts(ownerAgentId: string) {
  const { data, error } = await getSupabaseClient()
    .from('contacts')
    .select('contact_agent_id, created_at')
    .eq('owner_agent_id', ownerAgentId)
    .order('created_at', { ascending: false })

  if (error) throw error
  if (!data || data.length === 0) return []

  // Fetch agent profiles for each contact
  const agentIds = data.map((d) => d.contact_agent_id)
  const { data: agents, error: agentError } = await getSupabaseClient()
    .from('agents')
    .select('id, handle, display_name, description, status, trust_score')
    .in('id', agentIds)

  if (agentError) throw agentError

  const agentMap = new Map((agents ?? []).map((a) => [a.id, a]))
  return data.map((d) => ({
    ...agentMap.get(d.contact_agent_id),
    added_at: d.created_at,
  }))
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

export async function blockAgent(blockerId: string, blockedId: string) {
  const { error } = await getSupabaseClient()
    .from('blocks')
    .upsert({ blocker_id: blockerId, blocked_id: blockedId })
  if (error) throw error
}

export async function unblockAgent(blockerId: string, blockedId: string) {
  const { error } = await getSupabaseClient()
    .from('blocks')
    .delete()
    .eq('blocker_id', blockerId)
    .eq('blocked_id', blockedId)
  if (error) throw error
}

// --- Reports ---

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

// --- Trust Score ---

export async function updateTrustScore(agentId: string, delta: number): Promise<number> {
  const { data, error } = await getSupabaseClient()
    .rpc('update_trust_score', { p_agent_id: agentId, p_delta: delta })
  if (error) throw error
  return data as number
}

export async function autoSuspendIfNeeded(agentId: string, threshold: number): Promise<boolean> {
  const { data, error } = await getSupabaseClient()
    .rpc('auto_suspend_if_needed', { p_agent_id: agentId, p_threshold: threshold })
  if (error) throw error
  return !!data
}
