import { getSupabaseClient } from '../client.js'

export async function findAgentByHandle(handle: string) {
  const { data, error } = await getSupabaseClient()
    .from('agents')
    .select('*')
    .eq('handle', handle)
    .in('status', ['active', 'restricted'])
    .single()
  if (error) return null
  return data
}

export async function findAgentById(id: string) {
  const { data, error } = await getSupabaseClient()
    .from('agents')
    .select('*')
    .eq('id', id)
    .single()
  if (error) return null
  return data
}

export async function findAgentByApiKeyHash(hash: string) {
  const { data, error } = await getSupabaseClient()
    .from('agents')
    .select('*')
    .eq('api_key_hash', hash)
    .in('status', ['active', 'restricted', 'suspended'])
    .single()
  if (error) return null
  return data
}

/** Count total agents (all statuses) registered with this email — for lifetime limit */
export async function countAgentsByEmail(email: string): Promise<number> {
  const { count, error } = await getSupabaseClient()
    .from('agents')
    .select('*', { count: 'exact', head: true })
    .eq('email', email.toLowerCase().trim())
  if (error) throw error
  return count ?? 0
}

/** Check if there's a non-deleted agent with this email (active, restricted, or suspended) */
export async function findActiveAgentByEmail(email: string) {
  const { data, error } = await getSupabaseClient()
    .from('agents')
    .select('*')
    .eq('email', email.toLowerCase().trim())
    .in('status', ['active', 'restricted', 'suspended'])
    .single()
  if (error) return null
  return data
}

/**
 * Return the subset of agent ids whose paused_by_owner = 'full'.
 * Used by the group fan-out to drop fully-paused recipients before
 * pushing WS + webhook events. The caller already holds a candidate
 * id set from getGroupPushRecipients; this is a single IN query that
 * adds one round-trip to the fan-out path regardless of group size.
 */
export async function listFullyPausedAgentIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const { data, error } = await getSupabaseClient()
    .from('agents')
    .select('id')
    .in('id', ids)
    .eq('paused_by_owner', 'full')
  if (error) throw error
  return new Set((data ?? []).map((r) => r.id as string))
}

/** Fetch just the paused_by_owner column for one agent. Used by the
 *  WS reconnect drain to decide whether to flush the unread batch. */
export async function getPausedByOwner(id: string): Promise<string> {
  const { data, error } = await getSupabaseClient()
    .from('agents')
    .select('paused_by_owner')
    .eq('id', id)
    .single()
  if (error || !data) return 'none'
  return (data.paused_by_owner as string | null) ?? 'none'
}

/**
 * Flip the pause state. Used by the dashboard pause/unpause routes.
 * No status checks here — the service layer is expected to have already
 * verified ownership (via owner_agents) before calling this. The write
 * is a single UPDATE with the new enum value.
 */
export async function setPausedByOwner(
  id: string,
  mode: 'none' | 'send' | 'full',
): Promise<void> {
  const { error } = await getSupabaseClient()
    .from('agents')
    .update({ paused_by_owner: mode })
    .eq('id', id)
  if (error) throw error
}

export async function insertAgent(agent: {
  id: string
  handle: string
  email: string
  api_key_hash: string
  display_name?: string | null
  description?: string | null
}) {
  const { data, error } = await getSupabaseClient()
    .from('agents')
    .insert({
      id: agent.id,
      handle: agent.handle,
      email: agent.email,
      api_key_hash: agent.api_key_hash,
      display_name: agent.display_name ?? null,
      description: agent.description ?? null,
    })
    .select()
    .single()

  if (error) throw error
  return data
}
