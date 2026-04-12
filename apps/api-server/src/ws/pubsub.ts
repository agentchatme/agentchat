import Redis from 'ioredis'
import type { WSContext } from 'hono/ws'
import type { WsMessage } from '@agentchat/shared'
import { updateDeliveryStatus } from '@agentchat/db'
import { getConnections, closeAgentConnections } from './registry.js'

const CHANNEL_FANOUT = 'agentchat:ws:fanout'
const CHANNEL_CONTROL = 'agentchat:ws:control'

interface FanoutMessage {
  agentId: string
  message: WsMessage
}

interface ControlMessage {
  type: 'disconnect'
  agentId: string
  code: number
  reason: string
}

let pub: Redis | null = null
let sub: Redis | null = null

/**
 * Initialize Redis pub/sub for cross-server WebSocket fan-out.
 * If REDIS_URL is not set, pub/sub is disabled and delivery stays local-only.
 */
export function initPubSub(redisUrl?: string) {
  if (!redisUrl) {
    console.log('[pubsub] No REDIS_URL — local-only WebSocket delivery')
    return
  }

  pub = new Redis(redisUrl, { maxRetriesPerRequest: 3, lazyConnect: true })
  sub = new Redis(redisUrl, { maxRetriesPerRequest: 3, lazyConnect: true })

  pub.connect().catch((err) => {
    console.error('[pubsub] Publisher connect failed:', err.message)
  })

  sub.connect().then(() => {
    sub!.subscribe(CHANNEL_FANOUT, CHANNEL_CONTROL).catch((err) => {
      console.error('[pubsub] Subscribe failed:', err.message)
    })
  }).catch((err) => {
    console.error('[pubsub] Subscriber connect failed:', err.message)
  })

  sub.on('message', (channel: string, raw: string) => {
    if (channel === CHANNEL_FANOUT) {
      try {
        const { agentId, message } = JSON.parse(raw) as FanoutMessage
        deliverLocally(agentId, message)
      } catch {
        // Malformed — skip
      }
      return
    }

    if (channel === CHANNEL_CONTROL) {
      try {
        const msg = JSON.parse(raw) as ControlMessage
        if (msg.type === 'disconnect') {
          closeAgentConnections(msg.agentId, msg.code, msg.reason)
        }
      } catch {
        // Malformed — skip
      }
    }
  })

  sub.on('error', (err) => {
    console.error('[pubsub] Subscriber error:', err.message)
  })

  pub.on('error', (err) => {
    console.error('[pubsub] Publisher error:', err.message)
  })

  console.log('[pubsub] Redis pub/sub initialized')
}

/**
 * Publish a message for fan-out across all servers.
 * If pub/sub is not initialized, delivers locally only.
 */
export function publishToAgent(agentId: string, message: WsMessage) {
  if (pub) {
    const payload: FanoutMessage = { agentId, message }
    pub.publish(CHANNEL_FANOUT, JSON.stringify(payload)).catch(() => {
      // Publish failed — fall back to local delivery
      deliverLocally(agentId, message)
    })
  } else {
    // No pub/sub — deliver locally (single-server mode)
    deliverLocally(agentId, message)
  }
}

/**
 * Broadcast an agent-disconnect to every API server. Used after key
 * rotation, account deletion, or suspension — any live sockets holding
 * the now-invalid credential must be evicted on every host, not just
 * the one that handled the mutating request.
 *
 * Falls back to local-only close if pub/sub is disabled (single-server
 * mode). Best-effort: a failed publish also falls back to local close
 * rather than blocking the calling request.
 */
export function publishDisconnect(agentId: string, code: number, reason: string) {
  const payload: ControlMessage = { type: 'disconnect', agentId, code, reason }
  if (pub) {
    pub.publish(CHANNEL_CONTROL, JSON.stringify(payload)).catch(() => {
      closeAgentConnections(agentId, code, reason)
    })
  } else {
    closeAgentConnections(agentId, code, reason)
  }
}

/**
 * Deliver to local WebSocket connections only (called by subscriber on each server).
 * Iterates every local socket for the agent and marks the delivery envelope
 * as "delivered" after at least one successful send.
 */
function deliverLocally(agentId: string, message: WsMessage) {
  const connections = getConnections(agentId)
  if (connections.size === 0) return

  const raw = JSON.stringify(message)
  let delivered = false

  for (const ws of connections) {
    try {
      ws.send(raw)
      delivered = true
    } catch {
      // Dead connection — cleanup happens on close event
    }
  }

  // Mark this agent's delivery envelope as "delivered" only after at least
  // one local WebSocket actually accepted the message. Only for message.new
  // events (read receipts, presence, etc. carry no message_id to update).
  if (delivered && message.type === 'message.new' && message.payload?.id) {
    updateDeliveryStatus(message.payload.id as string, agentId, 'delivered').catch(() => {
      // Non-critical — sync on reconnect will catch it
    })
  }
}

/**
 * Deliver a message to a single specific socket. Used by the drain path on
 * reconnect so a newly-joined socket can receive its backlog without
 * fanning out through pub/sub — which would replay the drain to every
 * other local socket already holding the same agent. Marks the delivery
 * envelope as "delivered" on success.
 *
 * Returns true if the send succeeded (caller can continue draining) or
 * false if the socket is dead (caller should bail).
 */
export function deliverToSocket(
  ws: WSContext,
  agentId: string,
  message: WsMessage,
): boolean {
  try {
    ws.send(JSON.stringify(message))
  } catch {
    return false
  }
  if (message.type === 'message.new' && message.payload?.id) {
    updateDeliveryStatus(message.payload.id as string, agentId, 'delivered').catch(() => {
      // Non-critical — sync on reconnect will catch it
    })
  }
  return true
}

export function isPubSubEnabled(): boolean {
  return pub !== null
}

/** Disconnect Redis pub/sub — called during graceful shutdown */
export function shutdownPubSub() {
  if (sub) {
    sub.unsubscribe().catch(() => {})
    sub.disconnect()
    sub = null
  }
  if (pub) {
    pub.disconnect()
    pub = null
  }
  console.log('[pubsub] Disconnected')
}
