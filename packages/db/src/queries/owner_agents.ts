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

/**
 * List every agent an owner has claimed, joined with the agent row so the
 * dashboard list view can render status + pause state + profile in one
 * round trip. Soft-deleted agents (status='deleted') are filtered out
 * by the service layer in listAgentsForOwner — this raw query returns
 * everything the embed yields, including deleted rows.
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

// ─── Dashboard WS owner resolution ─────────────────────────────────────────
// findOwnerIdForAgent answers "which owner should get the dashboard push for
// a message sent/received by this agent?". Called on the message hot path,
// so it's backed by an in-process LRU cache. Owner ↔ agent claims change
// only on claim/release (both rare relative to message volume), so a short
// TTL is safe:
//
//   * Hit on a live claim → we push to the right owner.
//   * Hit on a just-released claim → we push to the old owner within the TTL
//     window; they'll see a ghost message, but their dashboard is also about
//     to stop receiving any fan-out so the window is bounded.
//   * Miss after a just-made claim → one-off lookup re-populates within the
//     TTL, and /dashboard/ws reconnects naturally pick up the new state.
//
// WIRE-CONTRACT-AMBIGUITY: the contract spells the query as
// `WHERE agent_id = $1 AND released_at IS NULL`, but the owner_agents table
// (migration 021) does NOT have a released_at column — release is a hard
// DELETE, so a row existing IS the "active claim" signal. Implemented as a
// straight PK lookup against agent_id.

interface OwnerCacheEntry {
  ownerId: string | null
  expiresAt: number
}

const OWNER_CACHE_MAX = 1000
const OWNER_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes for hits
const OWNER_CACHE_NULL_TTL_MS = 30 * 1000 // 30s for nulls, to blunt thundering herds

// Map preserves insertion order, which we abuse as LRU: every hit re-inserts
// the key at the tail, and overflow evicts from the head. No external dep.
const ownerCache = new Map<string, OwnerCacheEntry>()

function cacheGet(agentId: string): OwnerCacheEntry | undefined {
  const entry = ownerCache.get(agentId)
  if (!entry) return undefined
  if (entry.expiresAt < Date.now()) {
    ownerCache.delete(agentId)
    return undefined
  }
  // LRU bump: re-insert at the tail so the next eviction hits cold keys first.
  ownerCache.delete(agentId)
  ownerCache.set(agentId, entry)
  return entry
}

function cacheSet(agentId: string, ownerId: string | null) {
  const ttl = ownerId === null ? OWNER_CACHE_NULL_TTL_MS : OWNER_CACHE_TTL_MS
  ownerCache.set(agentId, { ownerId, expiresAt: Date.now() + ttl })
  if (ownerCache.size > OWNER_CACHE_MAX) {
    // Delete the head (oldest insertion) — Map.keys() iterates in order.
    const oldest = ownerCache.keys().next().value
    if (oldest !== undefined) ownerCache.delete(oldest)
  }
}

/**
 * Resolve the owner id that currently claims this agent, or null if the
 * agent is unclaimed. Backed by an LRU cache (5-minute TTL on hits, 30s
 * on nulls, cap ~1000 entries) — the owner → agent mapping changes only
 * on claim/release, so brief staleness is safe for the dashboard push path.
 */
export async function findOwnerIdForAgent(agentId: string): Promise<string | null> {
  const cached = cacheGet(agentId)
  if (cached) return cached.ownerId

  const { data, error } = await getSupabaseClient()
    .from('owner_agents')
    .select('owner_id')
    .eq('agent_id', agentId)
    .maybeSingle()

  if (error) {
    // Don't cache DB errors — the next call should get a fresh try.
    throw new Error(error.message)
  }

  const ownerId = (data?.owner_id as string | undefined) ?? null
  cacheSet(agentId, ownerId)
  return ownerId
}
