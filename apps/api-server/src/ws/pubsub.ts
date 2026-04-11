import Redis from 'ioredis'
import type { WsMessage } from '@agentchat/shared'
import { getConnections } from './registry.js'

const CHANNEL = 'agentchat:ws:fanout'

interface FanoutMessage {
  agentId: string
  message: WsMessage
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
    sub!.subscribe(CHANNEL).catch((err) => {
      console.error('[pubsub] Subscribe failed:', err.message)
    })
  }).catch((err) => {
    console.error('[pubsub] Subscriber connect failed:', err.message)
  })

  sub.on('message', (_channel: string, raw: string) => {
    try {
      const { agentId, message } = JSON.parse(raw) as FanoutMessage
      deliverLocally(agentId, message)
    } catch {
      // Malformed message — skip
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
    pub.publish(CHANNEL, JSON.stringify(payload)).catch(() => {
      // Publish failed — fall back to local delivery
      deliverLocally(agentId, message)
    })
  } else {
    // No pub/sub — deliver locally (single-server mode)
    deliverLocally(agentId, message)
  }
}

/** Deliver to local WebSocket connections only (called by subscriber on each server) */
function deliverLocally(agentId: string, message: WsMessage) {
  const connections = getConnections(agentId)
  const payload = JSON.stringify(message)
  for (const ws of connections) {
    try {
      ws.send(payload)
    } catch {
      // Dead connection — cleanup happens on close event
    }
  }
}

export function isPubSubEnabled(): boolean {
  return pub !== null
}
