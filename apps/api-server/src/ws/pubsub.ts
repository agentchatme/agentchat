import Redis from 'ioredis'
import type { WSContext } from 'hono/ws'
import type { WsMessage } from '@agentchat/shared'
import { updateDeliveryStatus } from '@agentchat/db'
import { getConnections, closeAgentConnections } from './registry.js'
import { deliverLocallyToOwner, closeOwnerConnections } from './owner-registry.js'
import { safeSend } from './safe-send.js'
import { logger } from '../lib/logger.js'
import { Sentry } from '../instrument.js'
import {
  pubsubPublishes,
  pubsubMessagesReceived,
  pubsubLocalFallbacks,
  pubsubReconnects,
  pubsubPublisherConnected,
  pubsubSubscriberConnected,
  pubsubPublishSeconds,
} from '../lib/metrics.js'

const CHANNEL_FANOUT = 'agentchat:ws:fanout'
const CHANNEL_CONTROL = 'agentchat:ws:control'
const OWNER_CHANNEL = 'agentchat:ws:owner-fanout'
const CHANNEL_PRESENCE = 'agentchat:ws:presence'

interface FanoutMessage {
  agentId: string
  message: WsMessage
}

interface OwnerFanoutMessage {
  ownerId: string
  message: unknown
}

interface PresenceFanoutMessage {
  /** The agent whose presence changed */
  sourceAgentId: string
  /** Agents who have sourceAgentId as a contact — only these receive the push */
  subscriberIds: string[]
  /** The wire payload pushed to each subscriber */
  event: { handle: string; status: string; custom_message: string | null }
}

type ControlMessage =
  | {
      type: 'disconnect'
      agentId: string
      code: number
      reason: string
    }
  | {
      kind: 'owner-signout'
      ownerId: string
    }

let pub: Redis | null = null
let sub: Redis | null = null

// ─── Connection-state tracking ────────────────────────────────────────────
//
// The connected gauges read these flags on every Prometheus scrape (the
// gauge's provider is invoked at serialize time, not on a timer). The
// publisher/subscriberDisconnectedAt timestamps anchor the sustained-
// disconnect Sentry alerts: we don't page on every transient blip, only
// on disconnects that exceed the grace window.
let publisherReady = false
let subscriberReady = false
let publisherDisconnectedAt: number | null = null
let subscriberDisconnectedAt: number | null = null
let publisherAlertTimer: NodeJS.Timeout | null = null
let subscriberAlertTimer: NodeJS.Timeout | null = null
let publisherAlerted = false
let subscriberAlerted = false

// 30s grace before we page on a publisher OR subscriber disconnect. ioredis's
// default reconnect strategy retries with exponential backoff starting at
// 50ms — a healthy reconnect after a transient blip lands well under 30s.
// Anything that persists past this window is a real outage worth waking
// someone for. The same value covers both clients because both have the
// same blast-radius profile (cross-machine fan-out broken, in opposite
// directions).
const SUSTAINED_DISCONNECT_ALERT_DELAY_MS = 30_000

/**
 * Initialize Redis pub/sub for cross-server WebSocket fan-out.
 * If REDIS_URL is not set, pub/sub is disabled and delivery stays local-only.
 */
export function initPubSub(redisUrl?: string) {
  if (!redisUrl) {
    logger.info('pubsub_disabled_no_redis_url')
    return
  }

  pub = new Redis(redisUrl, { maxRetriesPerRequest: 3, lazyConnect: true })
  sub = new Redis(redisUrl, { maxRetriesPerRequest: 3, lazyConnect: true })

  // Wire the gauges to the live ready-state flags. The provider is invoked
  // every Prometheus scrape, so the gauge reflects the state at scrape time
  // without any per-event mutation churn.
  pubsubPublisherConnected.set(() => (publisherReady ? 1 : 0))
  pubsubSubscriberConnected.set(() => (subscriberReady ? 1 : 0))

  attachLifecycleHooks(pub, 'publisher')
  attachLifecycleHooks(sub, 'subscriber')

  pub.connect().catch((err) => {
    logger.error({ err: { message: err.message } }, 'pubsub_publisher_initial_connect_failed')
  })

  sub.connect().then(() => {
    sub!.subscribe(CHANNEL_FANOUT, CHANNEL_CONTROL, OWNER_CHANNEL, CHANNEL_PRESENCE).catch((err) => {
      logger.error({ err: { message: err.message } }, 'pubsub_subscribe_failed')
    })
  }).catch((err) => {
    logger.error({ err: { message: err.message } }, 'pubsub_subscriber_initial_connect_failed')
  })

  sub.on('message', (channel: string, raw: string) => {
    pubsubMessagesReceived.inc({ channel })

    if (channel === CHANNEL_FANOUT) {
      try {
        const { agentId, message } = JSON.parse(raw) as FanoutMessage
        deliverLocally(agentId, message)
      } catch {
        // Malformed — skip
      }
      return
    }

    if (channel === OWNER_CHANNEL) {
      try {
        const { ownerId, message } = JSON.parse(raw) as OwnerFanoutMessage
        deliverLocallyToOwner(ownerId, message)
      } catch {
        // Malformed — skip
      }
      return
    }

    if (channel === CHANNEL_PRESENCE) {
      try {
        const { subscriberIds, event } = JSON.parse(raw) as PresenceFanoutMessage
        deliverPresenceLocally(subscriberIds, event)
      } catch {
        // Malformed — skip
      }
      return
    }

    if (channel === CHANNEL_CONTROL) {
      try {
        const msg = JSON.parse(raw) as ControlMessage
        if ('type' in msg && msg.type === 'disconnect') {
          closeAgentConnections(msg.agentId, msg.code, msg.reason)
        } else if ('kind' in msg && msg.kind === 'owner-signout') {
          // Owner signed out of every device — evict dashboard sockets on
          // every host so a stale tab can't keep receiving events past the
          // refresh-token revocation.
          closeOwnerConnections(msg.ownerId, 1008, 'Signed out')
        }
      } catch {
        // Malformed — skip
      }
    }
  })

  logger.info({ channels: [CHANNEL_FANOUT, CHANNEL_CONTROL, OWNER_CHANNEL, CHANNEL_PRESENCE] }, 'pubsub_initialized')
}

/**
 * Wire ioredis lifecycle events to metrics + Sentry alerting.
 *
 * Event taxonomy (ioredis docs):
 *   ready         — TCP connected + AUTH succeeded; client is usable
 *   close         — connection terminated; auto-reconnect is scheduled
 *   reconnecting  — about to reconnect after backoff (incrementing counter
 *                   here lets us see flap rates without watching logs)
 *   error         — protocol or socket error (ioredis logs separately)
 *   end           — gave up reconnecting; client is dead until process restart
 *
 * Sustained-disconnect alert: when the client transitions ready → not-ready,
 * we arm a 30s timer. If the client comes back ready before the timer fires,
 * we cancel and stay quiet — that's a routine reconnect. If the timer fires,
 * we page Sentry once and mark `alerted = true` so we don't keep paging on
 * subsequent failed-reconnect events from the same outage. When the client
 * eventually returns to ready, we log the resolution (no Sentry — there's no
 * canonical "resolved" event in Sentry's taxonomy; on-call only needs to
 * know the original alert is no longer breaching).
 *
 * Why the alert lives here and not in dlq-probe.ts: dlq-probe ticks every
 * 5 minutes — way too coarse to catch the 30s threshold. The pubsub.ts
 * client owns the lifecycle; firing the alert from the same place that
 * sees the lifecycle event keeps the latency to the order of the event
 * loop, not the probe interval.
 */
function attachLifecycleHooks(client: Redis, role: 'publisher' | 'subscriber') {
  client.on('ready', () => {
    if (role === 'publisher') {
      publisherReady = true
      publisherDisconnectedAt = null
      if (publisherAlertTimer) {
        clearTimeout(publisherAlertTimer)
        publisherAlertTimer = null
      }
      if (publisherAlerted) {
        logger.warn({ role }, 'pubsub_publisher_disconnect_resolved')
        publisherAlerted = false
      }
    } else {
      subscriberReady = true
      subscriberDisconnectedAt = null
      if (subscriberAlertTimer) {
        clearTimeout(subscriberAlertTimer)
        subscriberAlertTimer = null
      }
      if (subscriberAlerted) {
        logger.warn({ role }, 'pubsub_subscriber_disconnect_resolved')
        subscriberAlerted = false
      }
    }
    logger.info({ role }, 'pubsub_client_ready')
  })

  client.on('close', () => {
    const now = Date.now()
    if (role === 'publisher') {
      // Only arm the alert timer on the *first* close after a ready —
      // subsequent reconnect attempts that fail will fire 'close' again,
      // and we don't want to reset the grace window on every retry.
      if (publisherReady) {
        publisherDisconnectedAt = now
        if (!publisherAlertTimer && !publisherAlerted) {
          publisherAlertTimer = setTimeout(
            () => firePublisherDisconnectAlert(),
            SUSTAINED_DISCONNECT_ALERT_DELAY_MS,
          )
        }
      }
      publisherReady = false
    } else {
      if (subscriberReady) {
        subscriberDisconnectedAt = now
        if (!subscriberAlertTimer && !subscriberAlerted) {
          subscriberAlertTimer = setTimeout(
            () => fireSubscriberDisconnectAlert(),
            SUSTAINED_DISCONNECT_ALERT_DELAY_MS,
          )
        }
      }
      subscriberReady = false
    }
    logger.warn({ role }, 'pubsub_client_close')
  })

  client.on('reconnecting', (delay: number) => {
    pubsubReconnects.inc({ role })
    logger.warn({ role, delay_ms: delay }, 'pubsub_client_reconnecting')
  })

  client.on('error', (err) => {
    logger.error({ role, err: { message: err.message } }, 'pubsub_client_error')
  })

  client.on('end', () => {
    // 'end' = gave up. ioredis's default reconnect strategy gives up only
    // when maxRetriesPerRequest is exhausted on a per-command basis — for
    // pub/sub clients with no in-flight commands, this typically means an
    // explicit disconnect() call (graceful shutdown). Still worth logging
    // loudly in case it happens unexpectedly.
    if (role === 'publisher') {
      publisherReady = false
    } else {
      subscriberReady = false
    }
    logger.warn({ role }, 'pubsub_client_end')
  })
}

function firePublisherDisconnectAlert() {
  publisherAlertTimer = null
  publisherAlerted = true
  const downtimeMs = publisherDisconnectedAt ? Date.now() - publisherDisconnectedAt : 0
  Sentry.captureMessage('pubsub_publisher_disconnected_sustained', {
    level: 'error',
    tags: { component: 'pubsub' },
    extra: {
      role: 'publisher',
      downtime_ms: downtimeMs,
      grace_ms: SUSTAINED_DISCONNECT_ALERT_DELAY_MS,
    },
  })
  logger.error(
    { role: 'publisher', downtime_ms: downtimeMs, grace_ms: SUSTAINED_DISCONNECT_ALERT_DELAY_MS },
    'pubsub_publisher_disconnected_sustained',
  )
}

function fireSubscriberDisconnectAlert() {
  subscriberAlertTimer = null
  subscriberAlerted = true
  const downtimeMs = subscriberDisconnectedAt ? Date.now() - subscriberDisconnectedAt : 0
  Sentry.captureMessage('pubsub_subscriber_disconnected_sustained', {
    level: 'error',
    tags: { component: 'pubsub' },
    extra: {
      role: 'subscriber',
      downtime_ms: downtimeMs,
      grace_ms: SUSTAINED_DISCONNECT_ALERT_DELAY_MS,
    },
  })
  logger.error(
    { role: 'subscriber', downtime_ms: downtimeMs, grace_ms: SUSTAINED_DISCONNECT_ALERT_DELAY_MS },
    'pubsub_subscriber_disconnected_sustained',
  )
}

/**
 * Internal publish helper — wraps a Redis PUBLISH with metrics +
 * fallback handling so every public publishX function gets the same
 * instrumentation without copy-paste drift between channels.
 *
 * `channel` is in the metric labels; we don't add the agent/owner id
 * because labels with high cardinality (per-agent metrics) blow up
 * Prometheus storage — channel is bounded (4 values today), agent id
 * is not.
 */
async function publishWithMetrics(
  channel: string,
  payload: string,
  fallback: () => void,
): Promise<void> {
  if (!pub) {
    pubsubLocalFallbacks.inc({ channel })
    fallback()
    return
  }

  const start = Date.now()
  try {
    await pub.publish(channel, payload)
    pubsubPublishes.inc({ channel, outcome: 'success' })
  } catch (err) {
    pubsubPublishes.inc({ channel, outcome: 'failure' })
    pubsubLocalFallbacks.inc({ channel })
    logger.warn(
      { channel, err: { message: err instanceof Error ? err.message : String(err) } },
      'pubsub_publish_failed',
    )
    fallback()
  } finally {
    pubsubPublishSeconds.observe((Date.now() - start) / 1000, { channel })
  }
}

/**
 * Publish a message for fan-out across all servers.
 * If pub/sub is not initialized, delivers locally only.
 */
export function publishToAgent(agentId: string, message: WsMessage) {
  const payload: FanoutMessage = { agentId, message }
  void publishWithMetrics(CHANNEL_FANOUT, JSON.stringify(payload), () =>
    deliverLocally(agentId, message),
  )
}

/**
 * Publish a dashboard message for an owner. Mirrors publishToAgent:
 * when Redis is enabled, the publish loops back through the subscriber
 * which calls deliverLocallyToOwner on every server (including this one).
 * When Redis is disabled we deliver locally directly — single-server mode.
 */
export function publishToOwner(ownerId: string, message: unknown) {
  const payload: OwnerFanoutMessage = { ownerId, message }
  void publishWithMetrics(OWNER_CHANNEL, JSON.stringify(payload), () =>
    deliverLocallyToOwner(ownerId, message),
  )
}

/**
 * Broadcast an owner sign-out to every API server. Used by
 * POST /dashboard/auth/logout/all so every host drops the dashboard WS
 * held by any tab authenticated as this owner. Falls back to local-only
 * close when pub/sub is disabled.
 */
export function publishOwnerSignout(ownerId: string) {
  const payload: ControlMessage = { kind: 'owner-signout', ownerId }
  void publishWithMetrics(CHANNEL_CONTROL, JSON.stringify(payload), () =>
    closeOwnerConnections(ownerId, 1008, 'Signed out'),
  )
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
  void publishWithMetrics(CHANNEL_CONTROL, JSON.stringify(payload), () =>
    closeAgentConnections(agentId, code, reason),
  )
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
    // safeSend enforces the per-socket bufferedAmount ceiling — a slow
    // consumer that's fallen behind gets closed with 1013 instead of
    // accumulating heap. The reconnect's sync drain catches them up.
    if (safeSend(ws, raw)) {
      delivered = true
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
  if (!safeSend(ws, JSON.stringify(message))) return false
  if (message.type === 'message.new' && message.payload?.id) {
    updateDeliveryStatus(message.payload.id as string, agentId, 'delivered').catch(() => {
      // Non-critical — sync on reconnect will catch it
    })
  }
  return true
}

/**
 * Publish a presence change for fan-out. The message carries the full
 * subscriber list so each server can filter to its own local connections
 * without a DB lookup. Single pub/sub message regardless of subscriber
 * count — the cost is O(1) publish + O(local connections) delivery.
 */
export function publishPresence(
  sourceAgentId: string,
  subscriberIds: string[],
  event: { handle: string; status: string; custom_message: string | null },
) {
  const payload: PresenceFanoutMessage = { sourceAgentId, subscriberIds, event }
  void publishWithMetrics(CHANNEL_PRESENCE, JSON.stringify(payload), () =>
    deliverPresenceLocally(subscriberIds, event),
  )
}

/**
 * Deliver a presence update to every local subscriber socket. Iterates
 * the subscriber list, checks which agents have connections on THIS server,
 * and pushes the event. Dashboard gets presence via the REST endpoint
 * GET /dashboard/agents/:handle/presence (polling, not push).
 */
function deliverPresenceLocally(
  subscriberIds: string[],
  event: { handle: string; status: string; custom_message: string | null },
) {
  const raw = JSON.stringify({ type: 'presence.update', payload: event })

  for (const subscriberId of subscriberIds) {
    const conns = getConnections(subscriberId)
    for (const ws of conns) {
      safeSend(ws, raw)
    }
  }
}

export function isPubSubEnabled(): boolean {
  return pub !== null
}

/**
 * Pub/sub health snapshot for the /v1/health endpoint. Returns the live
 * ready-state of both clients. When REDIS_URL is unset (single-server
 * mode), `expected = false` and the health endpoint should treat both
 * disconnects as healthy — there's no Redis to be connected to.
 */
export function getPubSubHealth(): {
  expected: boolean
  publisherReady: boolean
  subscriberReady: boolean
} {
  return {
    expected: pub !== null,
    publisherReady,
    subscriberReady,
  }
}

/** Disconnect Redis pub/sub — called during graceful shutdown */
export function shutdownPubSub() {
  // Cancel any pending alert timers so a graceful shutdown doesn't
  // accidentally page Sentry mid-shutdown.
  if (publisherAlertTimer) {
    clearTimeout(publisherAlertTimer)
    publisherAlertTimer = null
  }
  if (subscriberAlertTimer) {
    clearTimeout(subscriberAlertTimer)
    subscriberAlertTimer = null
  }

  if (sub) {
    sub.unsubscribe().catch(() => {})
    sub.disconnect()
    sub = null
  }
  if (pub) {
    pub.disconnect()
    pub = null
  }
  publisherReady = false
  subscriberReady = false
  logger.info('pubsub_disconnected')
}
