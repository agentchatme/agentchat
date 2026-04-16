import { createHash } from 'node:crypto'
import type { WebSocket } from 'ws'
import { findAgentByApiKeyHash, getPausedByOwner } from '@agentchat/db'
import { addConnection, removeConnection, isOnline } from './registry.js'
import { syncUndelivered } from '../services/message.service.js'
import { deliverToSocket } from './pubsub.js'
import { setPresence, clearPresence, refreshPresenceTTL } from '../services/presence.service.js'
import type { WSContext } from 'hono/ws'

const HEARTBEAT_INTERVAL = 30_000 // 30 seconds
const PONG_TIMEOUT = 10_000 // 10 seconds to respond to ping

// Track active heartbeat timers so we can clean up on close
const heartbeats = new Map<WSContext, NodeJS.Timeout>()
const pongTimers = new Map<WSContext, NodeJS.Timeout>()

/**
 * Authenticate a WebSocket connection. Returns the agent's id AND handle
 * so the caller can pass both into handleWsConnection (presence broadcasts
 * need the handle on the wire, not just the internal id).
 */
export async function authenticateWs(
  token: string,
): Promise<{ id: string; handle: string } | null> {
  const hash = createHash('sha256').update(token).digest('hex')
  const agent = await findAgentByApiKeyHash(hash)
  if (!agent) return null
  return { id: agent.id as string, handle: agent.handle as string }
}

/**
 * Set up a fully-authenticated WS connection: register in the connection
 * map, set presence to online, start heartbeat, drain undelivered messages.
 *
 * Returns an `onClose` callback the caller must wire to the socket's close
 * event so cleanup (presence offline, heartbeat stop, registry remove) runs
 * exactly once.
 */
export function handleWsConnection(
  agentId: string,
  handle: string,
  ws: WSContext,
) {
  // Track whether this is the FIRST connection for this agent. If so,
  // the agent just came online and we need to broadcast presence.
  const wasOnline = isOnline(agentId)
  addConnection(agentId, ws)

  // Set presence to online only on FIRST connection. Additional
  // connections (multi-device / reconnect) don't re-broadcast —
  // contacts already know the agent is online.
  if (!wasOnline) {
    setPresence(agentId, handle, 'online', null, true).catch(() => {})
  } else {
    // Still refresh TTL so the key doesn't expire while the agent has
    // an active connection.
    refreshPresenceTTL(agentId).catch(() => {})
  }

  // Start heartbeat ping/pong cycle
  startHeartbeat(agentId, handle, ws)

  // On connect, drain all undelivered messages to THIS specific socket.
  // Sending via sendToAgent → pub/sub would fan the drain back out to every
  // other local socket for this agent and replay messages they've already
  // seen — wrong for multi-connection clients. Deliver directly instead.
  drainUndelivered(agentId, ws).catch(() => {
    // Non-critical — agent can always call /v1/messages/sync manually
  })

  return {
    onClose: () => {
      stopHeartbeat(ws)
      removeConnection(agentId, ws)

      // Only broadcast offline when the LAST connection for this agent
      // closes. If they still have other sockets, they're still online.
      if (!isOnline(agentId)) {
        clearPresence(agentId, handle).catch(() => {})
      }
    },
  }
}

const MAX_DRAIN_ITERATIONS = 50 // 50 × 200 = 10,000 messages max per reconnect
const DRAIN_BATCH_SIZE = 200

async function drainUndelivered(agentId: string, ws: WSContext) {
  // If the owner has fully paused this agent, skip the drain entirely.
  // The messages are durable in message_deliveries and will flush on the
  // first reconnect after the pause is lifted (or via /v1/messages/sync
  // which the agent can call itself to force a drain). Send-only pause
  // does NOT suppress the drain — the agent can still receive.
  //
  // Failover: if the pause lookup itself errors (DB blip mid-reconnect)
  // we log and proceed as 'none' so a transient outage doesn't block all
  // real-time delivery. The previous behaviour silently swallowed the
  // error which made DB issues invisible in this code path.
  let pausedMode: string = 'none'
  try {
    pausedMode = await getPausedByOwner(agentId)
  } catch (err) {
    console.error('[ws-drain] getPausedByOwner failed; assuming none:', agentId, err)
  }
  if (pausedMode === 'full') return

  let batch = await syncUndelivered(agentId)
  let iterations = 0
  while (batch.length > 0 && iterations < MAX_DRAIN_ITERATIONS) {
    for (const msg of batch) {
      const ok = deliverToSocket(ws, agentId, {
        type: 'message.new',
        payload: msg as Record<string, unknown>,
      })
      // If the socket died mid-drain, stop — the client will re-sync
      // on its next reconnect anyway.
      if (!ok) return
    }
    // Full batch → likely more waiting; partial → drained.
    if (batch.length < DRAIN_BATCH_SIZE) break
    iterations++
    // Small pause to avoid overwhelming the connection
    await new Promise((r) => setTimeout(r, 100))
    batch = await syncUndelivered(agentId)
  }
}

function startHeartbeat(agentId: string, handle: string, ws: WSContext) {
  const raw = ws.raw as WebSocket | undefined

  const interval = setInterval(() => {
    try {
      if (!raw || raw.readyState !== 1) {
        stopHeartbeat(ws)
        removeConnection(agentId, ws)
        if (!isOnline(agentId)) {
          clearPresence(agentId, handle).catch(() => {})
        }
        return
      }

      // Send ping frame
      raw.ping()

      // Start a timer — if no pong arrives, connection is dead
      const timeout = setTimeout(() => {
        try {
          ws.close(1001, 'Heartbeat timeout')
        } catch {
          // Already closed
        }
        stopHeartbeat(ws)
        removeConnection(agentId, ws)
        if (!isOnline(agentId)) {
          clearPresence(agentId, handle).catch(() => {})
        }
      }, PONG_TIMEOUT)

      pongTimers.set(ws, timeout)

      // Listen for pong — clears the timeout AND refreshes presence TTL
      raw.once('pong', () => {
        const timer = pongTimers.get(ws)
        if (timer) {
          clearTimeout(timer)
          pongTimers.delete(ws)
        }
        // Refresh the Redis presence TTL + Postgres last_seen on every pong.
        // This is the heartbeat-driven "proof of life" that keeps the 5-min
        // TTL from expiring while the agent is connected.
        refreshPresenceTTL(agentId).catch(() => {})
      })
    } catch {
      // Connection already dead — clean up
      stopHeartbeat(ws)
      removeConnection(agentId, ws)
      if (!isOnline(agentId)) {
        clearPresence(agentId, handle).catch(() => {})
      }
    }
  }, HEARTBEAT_INTERVAL)

  heartbeats.set(ws, interval)
}

function stopHeartbeat(ws: WSContext) {
  const interval = heartbeats.get(ws)
  if (interval) {
    clearInterval(interval)
    heartbeats.delete(ws)
  }
  const timeout = pongTimers.get(ws)
  if (timeout) {
    clearTimeout(timeout)
    pongTimers.delete(ws)
  }
}

/** Stop all heartbeats — called during graceful shutdown */
export function stopAllHeartbeats() {
  for (const [ws, interval] of heartbeats) {
    clearInterval(interval)
    const timeout = pongTimers.get(ws)
    if (timeout) clearTimeout(timeout)
  }
  heartbeats.clear()
  pongTimers.clear()
}
