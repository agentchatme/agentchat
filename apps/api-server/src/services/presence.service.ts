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
// last_seen atomically.  HSET + EXPIRE is pipelined into a single Upstash
// HTTP request so they either both execute or neither does.

const PRESENCE_TTL = 300 // 5 minutes
const PRESENCE_PREFIX = 'presence:'

// ─── Postgres write debounce ──────────────────────────────────────────────
// Redis is the live source of truth for last_seen; Postgres is the durable
// fallback for when the Redis key expires. Writing to Postgres on every
// heartbeat pong (every 30s per agent) is wasteful — 1,000 agents would
// produce 33 UPDATE/s just for timestamps. Instead, debounce: only flush to
// Postgres if the last write was more than 5 minutes ago. This means the
// durable last_seen can lag the live one by up to 5 minutes, which is fine
// because Postgres is only read when Redis has no key (agent offline).
const PG_WRITE_DEBOUNCE_MS = 5 * 60 * 1000 // 5 minutes
const lastPgWrite = new Map<string, number>()

function debouncedUpdateLastSeen(agentId: string) {
  const now = Date.now()
  const lastWrite = lastPgWrite.get(agentId) ?? 0
  if (now - lastWrite < PG_WRITE_DEBOUNCE_MS) return
  lastPgWrite.set(agentId, now)
  updateLastSeen(agentId).catch(() => {})
}

// Clean up debounce entries for disconnected agents so the map doesn't
// grow unbounded. Called from clearPresence.
function clearPgDebounce(agentId: string) {
  lastPgWrite.delete(agentId)
}

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

/**
 * Invalidate the subscriber cache for an agent. Must be called whenever
 * a contact relationship changes (add/remove) so the next presence
 * broadcast picks up the updated subscriber list instead of using stale
 * cached data for up to 2 minutes.
 */
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
 *
 * HSET + EXPIRE are pipelined into a single Upstash HTTP request so the
 * TTL is always set atomically with the data — no zombie keys if the
 * process crashes between two separate calls.
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

  const pipe = redis.pipeline()
  pipe.hset(key, {
    status,
    custom_message: customMessage ?? '',
    last_seen: now,
  })
  pipe.expire(key, PRESENCE_TTL)
  await pipe.exec()

  // Persist last_seen to Postgres (debounced — see top of file)
  debouncedUpdateLastSeen(agentId)

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
 * a broadcast storm. Also updates last_seen in both Redis and Postgres
 * (Postgres write is debounced to once per 5 minutes).
 *
 * Pipelined: EXISTS + HSET + EXPIRE in a single Upstash HTTP request.
 * If the key doesn't exist (race with explicit clearPresence), the
 * HSET/EXPIRE are harmless no-ops on the already-cleared key.
 */
export async function refreshPresenceTTL(agentId: string): Promise<void> {
  const redis = getRedis()
  const key = `${PRESENCE_PREFIX}${agentId}`
  const now = new Date().toISOString()

  // Pipeline: check exists, update last_seen, refresh TTL — one HTTP round-trip.
  // If the key was already deleted (agent went offline on another server),
  // the HSET recreates it with only last_seen — but the EXPIRE gives it
  // a 5-min TTL so it self-cleans. This is acceptable: the presence
  // response will show status as undefined/missing, and getPresence falls
  // back to 'offline' when status is absent.
  const pipe = redis.pipeline()
  pipe.exists(key)
  pipe.hset(key, { last_seen: now })
  pipe.expire(key, PRESENCE_TTL)
  const results = await pipe.exec()

  // Only proceed if the key existed before our HSET. results[0] is the
  // EXISTS response: 1 = existed, 0 = didn't.
  const existed = results[0] === 1
  if (!existed) {
    // Key didn't exist — our HSET created a bare key with only last_seen.
    // Delete it so we don't leave a status-less zombie.
    await redis.del(key)
    return
  }

  // Persist to Postgres (debounced)
  debouncedUpdateLastSeen(agentId)
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
 *
 * Pipelined: HSET offline + EXPIRE(60s) in one HTTP request. The short
 * TTL lets the "offline" key self-clean in a minute rather than lingering.
 */
export async function clearPresence(
  agentId: string,
  handle: string,
): Promise<void> {
  const redis = getRedis()
  const key = `${PRESENCE_PREFIX}${agentId}`
  const now = new Date().toISOString()

  const pipe = redis.pipeline()
  pipe.hset(key, { status: 'offline', last_seen: now, custom_message: '' })
  pipe.expire(key, 60)
  await pipe.exec()

  // Force a Postgres write on disconnect (bypass debounce) so the durable
  // last_seen reflects the actual disconnect time, not a 5-min-old stamp.
  clearPgDebounce(agentId)
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
 *
 * Processes in chunks of 50 to avoid overwhelming Upstash rate limits.
 * Best-effort: if shutdown times out (Fly gives ~10s), the 5-min Redis
 * TTL self-heals the remaining agents.
 */
export async function clearPresenceBatch(
  agents: Array<{ id: string; handle: string }>,
): Promise<void> {
  const CHUNK_SIZE = 50
  for (let i = 0; i < agents.length; i += CHUNK_SIZE) {
    const chunk = agents.slice(i, i + CHUNK_SIZE)
    await Promise.all(
      chunk.map(({ id, handle }) => clearPresence(id, handle)),
    )
  }
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
