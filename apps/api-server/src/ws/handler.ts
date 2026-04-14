import { createHash } from 'node:crypto'
import type { WebSocket } from 'ws'
import { findAgentByApiKeyHash, getPausedByOwner } from '@agentchat/db'
import { addConnection, removeConnection } from './registry.js'
import { syncUndelivered } from '../services/message.service.js'
import { deliverToSocket } from './pubsub.js'
import type { WSContext } from 'hono/ws'

const HEARTBEAT_INTERVAL = 30_000 // 30 seconds
const PONG_TIMEOUT = 10_000 // 10 seconds to respond to ping

// Track active heartbeat timers so we can clean up on close
const heartbeats = new Map<WSContext, NodeJS.Timeout>()
const pongTimers = new Map<WSContext, NodeJS.Timeout>()

export async function authenticateWs(token: string): Promise<string | null> {
  const hash = createHash('sha256').update(token).digest('hex')
  const agent = await findAgentByApiKeyHash(hash)
  if (!agent) return null
  return agent.id
}

export function handleWsConnection(agentId: string, ws: WSContext) {
  addConnection(agentId, ws)

  // Start heartbeat ping/pong cycle
  startHeartbeat(agentId, ws)

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
  const pausedMode = await getPausedByOwner(agentId).catch(() => 'none')
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

function startHeartbeat(agentId: string, ws: WSContext) {
  const raw = ws.raw as WebSocket | undefined

  const interval = setInterval(() => {
    try {
      if (!raw || raw.readyState !== 1) {
        stopHeartbeat(ws)
        removeConnection(agentId, ws)
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
      }, PONG_TIMEOUT)

      pongTimers.set(ws, timeout)

      // Listen for pong — clears the timeout
      raw.once('pong', () => {
        const timer = pongTimers.get(ws)
        if (timer) {
          clearTimeout(timer)
          pongTimers.delete(ws)
        }
      })
    } catch {
      // Connection already dead — clean up
      stopHeartbeat(ws)
      removeConnection(agentId, ws)
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
