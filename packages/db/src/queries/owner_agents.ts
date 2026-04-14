import { getSupabaseClient } from '../client.js'

// ─── Owner-agent claim mapping ─────────────────────────────────────────────
// One owner can claim many agents. Each agent can only be claimed by one
// owner at a time — enforced by `agent_id PRIMARY KEY`. A second claim
// attempt on the same agent surfaces as a unique-violation which routes
// map to ALREADY_CLAIMED (409).
//
// Cascade: deleting an owner drops all their claims; deleting an agent
// also drops the claim (agents can be soft-deleted via status='deleted',
// which doesn't trigger cascade, but a hard DELETE on agents would).

export async function insertOwnerAgent(params: {
  owner_id: string
  agent_id: string
}) {
  const { data, error } = await getSupabaseClient()
    .from('owner_agents')
    .insert({
      owner_id: params.owner_id,
      agent_id: params.agent_id,
    })
    .select()
    .single()

  if (error) throw error
  return data
}

export async function findOwnerAgent(ownerId: string, agentId: string) {
  const { data, error } = await getSupabaseClient()
    .from('owner_agents')
    .select('*')
    .eq('owner_id', ownerId)
    .eq('agent_id', agentId)
    .single()
  if (error) return null
  return data
}

export async function findClaimByAgentId(agentId: string) {
  const { data, error } = await getSupabaseClient()
    .from('owner_agents')
    .select('*')
    .eq('agent_id', agentId)
    .single()
  if (error) return null
  return data
}

/**
 * List every agent an owner has claimed, joined with the agent row so the
 * dashboard list view can render status + pause state + profile in one
 * round trip. Excludes deleted agents from the result — a deleted agent
 * cascades away from owner_agents anyway, but we also guard at query
 * time so a status='deleted' (soft delete) doesn't leak through.
 */
export async function listClaimedAgents(ownerId: string) {
  const { data, error } = await getSupabaseClient()
    .from('owner_agents')
    .select(
      `
      claimed_at,
      agents (
        id,
        handle,
        display_name,
        description,
        status,
        paused_by_owner,
        created_at
      )
    `,
    )
    .eq('owner_id', ownerId)
    .order('claimed_at', { ascending: false })

  if (error) throw error
  return data ?? []
}

export async function deleteOwnerAgent(ownerId: string, agentId: string) {
  const { error, count } = await getSupabaseClient()
    .from('owner_agents')
    .delete({ count: 'exact' })
    .eq('owner_id', ownerId)
    .eq('agent_id', agentId)

  if (error) throw error
  return (count ?? 0) > 0
}
