import { getRedis } from '../lib/redis.js'
import { updateLastSeen, getLastSeen, getAgentIdsByHandles } from '@agentchat/db'
import { listAgentsWhoAddedMeAsContact } from '@agentchat/db'
import { publishPresence } from '../ws/pubsub.js'
import type { PresenceStatus, PresenceBroadcast } from '@agentchat/shared'

// ─── Redis key layout ─────────────────────────────────────────────────────
// Each agent's live presence is a Redis HASH at `presence:{agentId}`:
//   status          — "online" | "offline" | "busy"
//   custom_message  — free-text (up to 200 chars, validated at the route)
//   last_seen       — ISO 8601 timestamp of last proof-of-life
//
// TTL: 5 minutes. The WS heartbeat (every 30s pong) refreshes the TTL,
// so a healthy connection keeps the key alive indefinitely. When the agent
// disconnects (or the server crashes), the key self-heals to offline after
// 5 min — no tombstone cleanup needed.
//
// Why HASH and not a plain string key?  We need status + custom_message +
// last_seen atomically.  HSET + EXPIRE is two commands but Upstash HTTP
// Redis handles them as a pipeline.

const PRESENCE_TTL = 300 // 5 minutes
const PRESENCE_PREFIX = 'presence:'

// ─── LRU cache for "who added me as contact" ─────────────────────────────
// Presence broadcasts need to know which agents care about a given agent's
// status change.  Hitting the DB on every heartbeat pong is wasteful — the
// contact graph changes slowly.  A 2-minute in-memory cache with a 1000-
// entry cap keeps the hot path fast and bounds memory.
const CONTACT_CACHE_TTL = 120_000 // 2 minutes
const CONTACT_CACHE_MAX = 1000

interface CacheEntry {
  agentIds: string[]
  expiresAt: number
}

const contactCache = new Map<string, CacheEntry>()

function getCachedSubscribers(agentId: string): string[] | null {
  const entry = contactCache.get(agentId)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    contactCache.delete(agentId)
    return null
  }
  return entry.agentIds
}

function setCachedSubscribers(agentId: string, agentIds: string[]) {
  // Evict oldest entry if at cap (simple FIFO — good enough for a cache
  // this small; a real LRU is overkill at 1000 entries).
  if (contactCache.size >= CONTACT_CACHE_MAX) {
    const oldest = contactCache.keys().next().value
    if (oldest) contactCache.delete(oldest)
  }
  contactCache.set(agentId, {
    agentIds,
    expiresAt: Date.now() + CONTACT_CACHE_TTL,
  })
}

/** Invalidate the subscriber cache for an agent. Called when contacts change. */
export function invalidatePresenceSubscribers(agentId: string) {
  contactCache.delete(agentId)
}

// ─── Core presence operations ─────────────────────────────────────────────

/**
 * Set an agent's presence in Redis and optionally broadcast the change.
 *
 * `broadcast` controls whether we fan the update out to contacts:
 *   - true for explicit PUT /v1/presence and on connect/disconnect
 *   - false for heartbeat TTL refreshes (no state change to announce)
 */
export async function setPresence(
  agentId: string,
  handle: string,
  status: PresenceStatus,
  customMessage?: string | null,
  broadcast = true,
): Promise<void> {
  const redis = getRedis()
  const key = `${PRESENCE_PREFIX}${agentId}`
  const now = new Date().toISOString()

  // Pipeline: HSET all fields + EXPIRE in one round-trip
  await redis.hset(key, {
    status,
    custom_message: customMessage ?? '',
    last_seen: now,
  })
  await redis.expire(key, PRESENCE_TTL)

  // Persist last_seen to Postgres (fire-and-forget — non-critical)
  updateLastSeen(agentId).catch(() => {})

  if (broadcast) {
    const event: PresenceBroadcast = {
      handle,
      status,
      custom_message: customMessage ?? null,
    }
    broadcastPresenceChange(agentId, event).catch(() => {})
  }
}

/**
 * Refresh the Redis TTL without changing any fields. Called on every
 * heartbeat pong — proves the agent is still alive without generating
 * a broadcast storm. Also updates last_seen in both Redis and Postgres.
 */
export async function refreshPresenceTTL(agentId: string): Promise<void> {
  const redis = getRedis()
  const key = `${PRESENCE_PREFIX}${agentId}`
  const now = new Date().toISOString()

  // Only refresh if the key exists (agent set presence at connect time).
  const exists = await redis.exists(key)
  if (!exists) return

  await redis.hset(key, { last_seen: now })
  await redis.expire(key, PRESENCE_TTL)

  // Persist to Postgres (fire-and-forget)
  updateLastSeen(agentId).catch(() => {})
}

/**
 * Get a single agent's presence. Returns the full Presence shape.
 * Falls back to Postgres last_seen_at when Redis key has expired.
 */
export async function getPresence(
  agentId: string,
  handle: string,
): Promise<{
  handle: string
  status: PresenceStatus
  custom_message: string | null
  last_seen: string | null
}> {
  const redis = getRedis()
  const key = `${PRESENCE_PREFIX}${agentId}`

  const data = await redis.hgetall<{
    status?: string
    custom_message?: string
    last_seen?: string
  }>(key)

  if (data && data.status) {
    return {
      handle,
      status: data.status as PresenceStatus,
      custom_message: data.custom_message || null,
      last_seen: data.last_seen || null,
    }
  }

  // Key expired or never set → agent is offline. Pull last_seen from Postgres.
  const lastSeen = await getLastSeen(agentId)
  return {
    handle,
    status: 'offline',
    custom_message: null,
    last_seen: lastSeen,
  }
}

/**
 * Batch presence lookup. Resolves handles → ids, then fetches presence
 * for each from Redis in parallel. Used by POST /v1/presence/batch.
 */
export async function getPresenceBatch(
  handles: string[],
): Promise<
  Array<{
    handle: string
    status: PresenceStatus
    custom_message: string | null
    last_seen: string | null
  }>
> {
  const handleToId = await getAgentIdsByHandles(handles)

  const results = await Promise.all(
    handles.map(async (handle) => {
      const agentId = handleToId.get(handle)
      if (!agentId) return null // handle doesn't exist — omit from results
      return getPresence(agentId, handle)
    }),
  )

  return results.filter(
    (r): r is NonNullable<typeof r> => r !== null,
  )
}

/**
 * Remove an agent's presence from Redis (explicit offline). Called on
 * last WS disconnect and during graceful shutdown.
 */
export async function clearPresence(
  agentId: string,
  handle: string,
): Promise<void> {
  const redis = getRedis()
  const key = `${PRESENCE_PREFIX}${agentId}`

  // Stamp last_seen before clearing so the offline response has a
  // meaningful timestamp.
  const now = new Date().toISOString()
  await redis.hset(key, { status: 'offline', last_seen: now, custom_message: '' })
  // Set a short TTL so the "offline" key self-cleans after a minute
  await redis.expire(key, 60)

  updateLastSeen(agentId).catch(() => {})

  const event: PresenceBroadcast = {
    handle,
    status: 'offline',
    custom_message: null,
  }
  broadcastPresenceChange(agentId, event).catch(() => {})
}

/**
 * Batch clear presence for multiple agents at once. Used during graceful
 * shutdown to mark all locally-connected agents as offline in one pass.
 * Broadcasts are sent per-agent because each has different subscribers.
 */
export async function clearPresenceBatch(
  agents: Array<{ id: string; handle: string }>,
): Promise<void> {
  await Promise.all(
    agents.map(({ id, handle }) => clearPresence(id, handle)),
  )
}

// ─── Broadcast ────────────────────────────────────────────────────────────

/**
 * Fan out a presence change to every agent that has `agentId` in their
 * contact book. Uses the LRU cache to avoid DB hammering.
 *
 * The broadcast goes through Redis pub/sub so every API server delivers
 * locally to its connected agents. A single publish message contains the
 * full subscriber list — each server filters to its own connections.
 */
async function broadcastPresenceChange(
  agentId: string,
  event: PresenceBroadcast,
): Promise<void> {
  const cached = getCachedSubscribers(agentId)
  const subscribers = cached ?? await listAgentsWhoAddedMeAsContact(agentId)
  if (!cached) {
    setCachedSubscribers(agentId, subscribers)
  }

  if (subscribers.length === 0) return

  // Publish one message with the subscriber list — each server will
  // filter to its own local connections.
  publishPresence(agentId, subscribers, event)
}
