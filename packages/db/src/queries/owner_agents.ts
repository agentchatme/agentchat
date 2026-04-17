import { Redis } from '@upstash/redis'
import { getSupabaseClient } from '../client.js'

let redisClient: Redis | null = null
function getRedis(): Redis {
  if (!redisClient) {
    redisClient = new Redis({
      url: process.env['UPSTASH_REDIS_REST_URL']!,
      token: process.env['UPSTASH_REDIS_REST_TOKEN']!,
    })
  }
  return redisClient
}

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
        avatar_key,
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
// so it's backed by a Redis cache (Upstash REST).
//
// Why Redis instead of in-process: with multiple api-server machines, an
// in-process Map would mean every machine has to hit Postgres on cold
// agents. At 1M agents that's a thundering herd of identical SELECTs the
// moment a deployment cycles or a new machine boots. A shared Redis cache
// means one DB hit per agent across the whole fleet.
//
// Staleness model unchanged:
//   * Hit on a live claim → push to the right owner.
//   * Hit on a just-released claim → push to the old owner within the TTL
//     window; their dashboard is about to stop receiving fan-out anyway,
//     so the ghost-message window is bounded.
//   * Miss after a just-made claim → one-off lookup re-populates; the
//     /dashboard/ws reconnect naturally picks up new state.
//
// Null caching with a short TTL (30s) blunts thundering herds against
// the DB when many agents are unclaimed (the common case for SDK-only
// agents that never visit a dashboard).
//
// WIRE-CONTRACT-AMBIGUITY: the contract spells the query as
// `WHERE agent_id = $1 AND released_at IS NULL`, but the owner_agents table
// (migration 021) does NOT have a released_at column — release is a hard
// DELETE, so a row existing IS the "active claim" signal. Implemented as a
// straight PK lookup against agent_id.

const OWNER_CACHE_TTL_SECONDS = 5 * 60 // hits
const OWNER_CACHE_NULL_TTL_SECONDS = 30 // nulls (thundering-herd blunt)
const OWNER_CACHE_PREFIX = 'oac:' // owner-agent-cache
const NULL_SENTINEL = '__null__'

/**
 * Resolve the owner id that currently claims this agent, or null if the
 * agent is unclaimed. Backed by Redis (5-minute TTL on hits, 30s on nulls).
 * Owner ↔ agent claims change only on claim/release, so brief staleness
 * is safe for the dashboard push path.
 *
 * Fail-open on Redis errors: a cache outage falls through to the DB rather
 * than killing the message hot path.
 */
export async function findOwnerIdForAgent(agentId: string): Promise<string | null> {
  const key = `${OWNER_CACHE_PREFIX}${agentId}`

  try {
    const cached = await getRedis().get<string>(key)
    if (cached !== null && cached !== undefined) {
      return cached === NULL_SENTINEL ? null : cached
    }
  } catch {
    // Redis miss — fall through to DB.
  }

  const { data, error } = await getSupabaseClient()
    .from('owner_agents')
    .select('owner_id')
    .eq('agent_id', agentId)
    .maybeSingle()

  if (error) {
    // Don't cache DB errors — next call should retry.
    throw new Error(error.message)
  }

  const ownerId = (data?.owner_id as string | undefined) ?? null

  // Best-effort cache write — a Redis outage shouldn't break the lookup.
  try {
    await getRedis().set(key, ownerId ?? NULL_SENTINEL, {
      ex: ownerId === null ? OWNER_CACHE_NULL_TTL_SECONDS : OWNER_CACHE_TTL_SECONDS,
    })
  } catch {
    // swallow
  }

  return ownerId
}

/**
 * Drop the cached owner mapping for an agent. Call this from claim/release
 * paths so the next read sees the new ownership immediately instead of
 * waiting out the TTL. Best-effort — TTL is the safety net.
 */
export async function invalidateOwnerCache(agentId: string): Promise<void> {
  try {
    await getRedis().del(`${OWNER_CACHE_PREFIX}${agentId}`)
  } catch {
    // swallow — TTL handles it
  }
}
