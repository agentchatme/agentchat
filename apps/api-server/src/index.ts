import './instrument.js' // MUST be first — Sentry hooks node internals at init
import './env.js' // Validate env vars immediately — crash on missing credentials
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createNodeWebSocket } from '@hono/node-ws'
import { serve } from '@hono/node-server'
import { registerRoutes } from './routes/register.js'
import { agentRoutes } from './routes/agents.js'
import { messageRoutes } from './routes/messages.js'
import { conversationRoutes } from './routes/conversations.js'
import { groupRoutes } from './routes/groups.js'
import { contactRoutes } from './routes/contacts.js'
import { muteRoutes } from './routes/mutes.js'
import { presenceRoutes } from './routes/presence.js'
import { webhookRoutes } from './routes/webhooks.js'
import { directoryRoutes } from './routes/directory.js'
import { uploadRoutes } from './routes/uploads.js'
import { attachmentRoutes } from './routes/attachments.js'
import { metricsRoutes } from './routes/metrics.js'
import { openapiRoutes } from './routes/openapi.js'
import { dashboardRoutes } from './routes/dashboard.js'
import { errorHandler } from './middleware/error-handler.js'
import { requestLogger } from './middleware/logger.js'
import { authenticateWs, handleWsConnection, stopAllHeartbeats } from './ws/handler.js'
import { initPubSub, shutdownPubSub, getPubSubHealth } from './ws/pubsub.js'
import { closeAllConnections, getAllConnectedAgentIds } from './ws/registry.js'
import {
  addOwnerConnection,
  removeOwnerConnection,
  closeAllOwnerConnections,
} from './ws/owner-registry.js'
import { consumeTicket } from './ws/ticket-store.js'
import { clearPresenceBatch } from './services/presence.service.js'
import { verifyAvatarBucket } from './services/avatar.service.js'
import { getAgentHandlesByIds } from '@agentchat/db'
import type { WebSocket as NodeWebSocket } from 'ws'
import type { WSContext } from 'hono/ws'

const app = new Hono()
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

// Global middleware
app.use('*', requestLogger)

// CORS — split per surface so dashboard cookie-auth and agent Bearer-auth
// don't share a policy. The audit (§2.10) called out that wildcard +
// credentials is a CSRF surface; we keep wildcard scoped to the routes
// where the API key IS the auth boundary (no cookies, no shared origin
// trust) and force an explicit allowlist on the cookie-auth dashboard.
//
// /v1/*  — agent API. Auth = `Authorization: Bearer <api_key>`. Browser
//   origin is NOT a trust boundary; the key is. Defaulting to `*` lets
//   any browser-hosted agent call us, matching Stripe/Twilio. Operators
//   may still pin it via CORS_ORIGINS for internal tooling.
//
// /dashboard/* — owner UI. Auth = signed session cookie. Wildcard +
//   credentials is the textbook CSRF amplifier; we never serve `*` here.
//   DASHBOARD_ORIGINS must be set for browsers to reach the dashboard
//   API at all (defaults to a closed allowlist in production). Local dev
//   commonly sets DASHBOARD_ORIGINS=http://localhost:3001.
//
// exposeHeaders: Retry-After lets the SDK read 429 backoff hints (fetch
//   hides non-whitelisted response headers otherwise). X-Backlog-Warning
//   surfaces the soft 5K-undelivered signal. Server-Timing is for browser
//   devtools on the cross-origin dashboard requests.
const corsOriginsRaw = process.env['CORS_ORIGINS']?.trim() ?? ''
const corsOrigin: string | string[] =
  corsOriginsRaw === '' || corsOriginsRaw === '*'
    ? '*'
    : corsOriginsRaw.split(',').map((s) => s.trim()).filter(Boolean)

const dashboardOriginsRaw = process.env['DASHBOARD_ORIGINS']?.trim() ?? ''
const dashboardOrigins: string[] =
  dashboardOriginsRaw === ''
    ? []
    : dashboardOriginsRaw.split(',').map((s) => s.trim()).filter(Boolean)

// Agent API (Bearer auth, no cookies). Wildcard origin is acceptable
// because the API key — not the browser origin — is the auth credential.
app.use(
  '/v1/*',
  cors({
    origin: corsOrigin,
    allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
    exposeHeaders: ['Retry-After', 'X-Backlog-Warning', 'Idempotent-Replay'],
    maxAge: 600,
    credentials: false,
  }),
)

// Dashboard (cookie auth). Strict allowlist + credentials. If
// DASHBOARD_ORIGINS is unset, we deny every cross-origin request — the
// dashboard MUST be deployed with the env var pointing at its origin
// before browsers can call it. Same-origin (no Origin header, or the
// dashboard served from the API origin) is unaffected.
app.use(
  '/dashboard/*',
  cors({
    origin: (origin) => (dashboardOrigins.includes(origin) ? origin : null),
    allowHeaders: ['Content-Type'],
    exposeHeaders: ['Retry-After', 'Server-Timing'],
    maxAge: 600,
    credentials: true,
  }),
)

app.onError(errorHandler)

// Health check
app.get('/', (c) => {
  return c.json({ name: 'AgentChat API', version: '0.2.0', status: 'alive' })
})

// Health check — also drives Fly's [checks.health] block (fly.toml line 71).
//
// When REDIS_URL is set, pub/sub is the load-bearing component for cross-
// machine WebSocket fan-out. A machine whose subscriber is down silently
// stops receiving any messages from other machines — recipients on this
// host miss every live push originating elsewhere until reconnect. We'd
// rather Fly's load balancer pull a sick machine out of rotation than
// keep routing live WS users into it. So: 503 if Redis is expected but
// neither client is ready; 200 otherwise.
//
// Why "neither" instead of "either" — the publisher being down only
// breaks outbound fan-out from this host (ugly but bounded; messages
// still hit Postgres and recipients drain on /sync). The subscriber
// being down breaks INBOUND fan-out to this host (every other machine's
// publishes are invisible). We require BOTH down before we ask Fly to
// quarantine us, because a half-degraded machine can still serve some
// traffic correctly while it self-heals; a fully-degraded one cannot.
//
// Single-server mode (REDIS_URL unset) always returns 200 — there's no
// Redis to be connected to, and local-only delivery is the intended
// behavior.
app.get('/v1/health', (c) => {
  const ps = getPubSubHealth()
  if (ps.expected && !ps.publisherReady && !ps.subscriberReady) {
    return c.json(
      {
        status: 'degraded',
        pubsub: { publisher: false, subscriber: false },
      },
      503,
    )
  }
  return c.json({
    status: 'ok',
    ...(ps.expected && {
      pubsub: { publisher: ps.publisherReady, subscriber: ps.subscriberReady },
    }),
  })
})

// WebSocket endpoint
//
// Authentication. The API key MUST NOT travel in the URL query string —
// that path leaks to access logs, browser history, Referer headers, and
// proxy caches. Two supported paths instead:
//
//   1. `Authorization: Bearer <key>` header — preferred for server clients
//      (Node SDK, curl, tests). Authenticated upfront at upgrade time.
//
//   2. HELLO frame — the ONLY path browsers have, since the native
//      WebSocket constructor cannot set custom headers. The server accepts
//      the connection unauthenticated, waits HELLO_TIMEOUT_MS for
//      `{type:'hello', api_key:'...'}`, then authenticates. No
//      message.new events are pushed until the HELLO succeeds — the
//      connection is NOT added to the registry pre-HELLO.
const HELLO_TIMEOUT_MS = 5_000

app.get(
  '/v1/ws',
  upgradeWebSocket(async (c) => {
    // Path 1: upfront Bearer auth
    const authHeader = c.req.header('Authorization')
    let upfrontAgent: { id: string; handle: string } | null = null
    if (authHeader?.startsWith('Bearer ')) {
      upfrontAgent = await authenticateWs(authHeader.slice(7))
      if (!upfrontAgent) {
        // Bad key — fail-closed, don't fall through to HELLO.
        return { onOpen: (_evt, ws) => { ws.close(1008, 'Invalid token') } }
      }
    }

    if (upfrontAgent) {
      const { id: agentId, handle } = upfrontAgent
      return {
        onOpen: (_evt, ws) => {
          const { onClose } = handleWsConnection(agentId, handle, ws)
          ws.raw?.addEventListener('close', onClose)
        },
        onMessage: (_evt, _ws) => {
          // Future: handle client actions here (typing, read acks)
        },
      }
    }

    // Path 2: HELLO frame — per-connection closure state.
    let authenticated = false
    let helloTimeout: NodeJS.Timeout | null = null

    return {
      onOpen: (_evt, ws) => {
        helloTimeout = setTimeout(() => {
          if (!authenticated) {
            try { ws.close(1008, 'HELLO frame required') } catch { /* already closed */ }
          }
        }, HELLO_TIMEOUT_MS)
      },
      onMessage: async (evt, ws) => {
        if (!authenticated) {
          let data: { type?: unknown; api_key?: unknown } = {}
          try {
            data = JSON.parse(String(evt.data))
          } catch {
            try { ws.close(1008, 'HELLO frame required first') } catch { /* already closed */ }
            return
          }

          if (data.type !== 'hello' || typeof data.api_key !== 'string') {
            try { ws.close(1008, 'HELLO frame required first') } catch { /* already closed */ }
            return
          }

          const agent = await authenticateWs(data.api_key)
          if (!agent) {
            try { ws.close(1008, 'Invalid token') } catch { /* already closed */ }
            return
          }

          if (helloTimeout) {
            clearTimeout(helloTimeout)
            helloTimeout = null
          }
          authenticated = true

          const { onClose } = handleWsConnection(agent.id, agent.handle, ws)
          ws.raw?.addEventListener('close', onClose)

          // ACK so the client knows auth succeeded before trusting the session.
          try {
            ws.send(JSON.stringify({ type: 'hello.ok' }))
          } catch {
            // Connection already gone — cleanup happens on close event
          }
          return
        }

        // Future: handle client actions here (typing, read acks)
      },
      onClose: () => {
        if (helloTimeout) {
          clearTimeout(helloTimeout)
          helloTimeout = null
        }
      },
    }
  }),
)

// Dashboard WebSocket — read-only push channel for the Next.js dashboard.
//
// Auth is the one-shot ticket at POST /dashboard/ws/ticket (see
// WIRE-CONTRACT §1). The ticket is consumed on upgrade; we never accept
// an unauthenticated dashboard socket. Any application-level frame from
// the client is ignored — the channel is strictly server → client.
//
// Heartbeat mirrors the agent WS (ws/handler.ts): PING every 30s, close
// if no PONG within 10s. Dashboard tabs get backgrounded heavily so a
// dead socket is more common here than on the agent side.
const DASHBOARD_WS_HEARTBEAT_INTERVAL = 30_000
const DASHBOARD_WS_PONG_TIMEOUT = 10_000

// Per-connection heartbeat bookkeeping, identical to the agent side.
const dashboardHeartbeats = new Map<WSContext, NodeJS.Timeout>()
const dashboardPongTimers = new Map<WSContext, NodeJS.Timeout>()

function startDashboardHeartbeat(ownerId: string, ws: WSContext) {
  const raw = ws.raw as NodeWebSocket | undefined

  const interval = setInterval(() => {
    try {
      if (!raw || raw.readyState !== 1) {
        stopDashboardHeartbeat(ws)
        removeOwnerConnection(ownerId, ws)
        return
      }

      raw.ping()

      const timeout = setTimeout(() => {
        try {
          ws.close(1001, 'Heartbeat timeout')
        } catch {
          // Already closed
        }
        stopDashboardHeartbeat(ws)
        removeOwnerConnection(ownerId, ws)
      }, DASHBOARD_WS_PONG_TIMEOUT)

      dashboardPongTimers.set(ws, timeout)

      raw.once('pong', () => {
        const timer = dashboardPongTimers.get(ws)
        if (timer) {
          clearTimeout(timer)
          dashboardPongTimers.delete(ws)
        }
      })
    } catch {
      stopDashboardHeartbeat(ws)
      removeOwnerConnection(ownerId, ws)
    }
  }, DASHBOARD_WS_HEARTBEAT_INTERVAL)

  dashboardHeartbeats.set(ws, interval)
}

function stopDashboardHeartbeat(ws: WSContext) {
  const interval = dashboardHeartbeats.get(ws)
  if (interval) {
    clearInterval(interval)
    dashboardHeartbeats.delete(ws)
  }
  const timeout = dashboardPongTimers.get(ws)
  if (timeout) {
    clearTimeout(timeout)
    dashboardPongTimers.delete(ws)
  }
}

function stopAllDashboardHeartbeats() {
  for (const [, interval] of dashboardHeartbeats) {
    clearInterval(interval)
  }
  for (const [, timeout] of dashboardPongTimers) {
    clearTimeout(timeout)
  }
  dashboardHeartbeats.clear()
  dashboardPongTimers.clear()
}

app.get(
  '/v1/ws/dashboard',
  upgradeWebSocket(async (c) => {
    // Ticket consume happens at upgrade time (inside the handler factory)
    // so an invalid/expired ticket closes the socket on its very first
    // frame. Reading it here (not inside onOpen) lets us fail-fast without
    // allocating a heartbeat.
    const ticket = c.req.query('ticket') ?? ''
    const ownerId = ticket ? await consumeTicket(ticket) : null

    if (!ownerId) {
      return {
        onOpen: (_evt, ws) => {
          try {
            ws.close(1008, 'Invalid ticket')
          } catch {
            // Already closed
          }
        },
      }
    }

    const boundOwnerId = ownerId
    return {
      onOpen: (_evt, ws) => {
        addOwnerConnection(boundOwnerId, ws)
        // First frame must be hello.ok so the client can confirm end-to-end
        // auth before trusting the session (WIRE-CONTRACT §Events/hello.ok).
        try {
          ws.send(JSON.stringify({ type: 'hello.ok', owner_id: boundOwnerId }))
        } catch {
          // Connection already gone — cleanup fires via onClose
        }
        startDashboardHeartbeat(boundOwnerId, ws)
      },
      onMessage: (_evt, _ws) => {
        // Read-only channel. Any client application frame is silently
        // discarded (WIRE-CONTRACT §2 Client → server frames: none).
      },
      onClose: (_evt, ws) => {
        stopDashboardHeartbeat(ws)
        removeOwnerConnection(boundOwnerId, ws)
      },
    }
  }),
)

// Mount routes
app.route('/v1/register', registerRoutes)
app.route('/v1/agents', agentRoutes)
app.route('/v1/messages', messageRoutes)
app.route('/v1/conversations', conversationRoutes)
app.route('/v1/groups', groupRoutes)
app.route('/v1/contacts', contactRoutes)
app.route('/v1/mutes', muteRoutes)
app.route('/v1/presence', presenceRoutes)
app.route('/v1/webhooks', webhookRoutes)
app.route('/v1/directory', directoryRoutes)
app.route('/v1/uploads', uploadRoutes)
app.route('/v1/attachments', attachmentRoutes)
// /internal/* is the convention for endpoints that are not part of the
// public API surface. Operators can lock the path prefix to private IPs
// at the load balancer / Fly proxy layer; clients have no business hitting
// it. The METRICS_TOKEN env var still gates access in case the prefix
// rule isn't in place.
app.route('/internal/metrics', metricsRoutes)
app.route('/v1/openapi.json', openapiRoutes)
app.route('/dashboard', dashboardRoutes)

// Initialize Redis pub/sub for multi-server WebSocket fan-out
initPubSub(process.env['REDIS_URL'])

// Fire-and-forget probe of the public `avatars` storage bucket. If the
// bucket is missing or misconfigured we log loudly and keep serving —
// avatar writes will 503 on their own, but the rest of the API stays
// up. This is a config sanity check, not a gate.
void verifyAvatarBucket()

// Webhook delivery polling lives in the dedicated `worker` process group
// (apps/api-server/src/worker.ts) so a request burst on the api process
// can't starve fan-out and a slow webhook receiver can't tie up the
// request loop. Both processes ship the same image; fly.toml [processes]
// picks the entrypoint.

// Start server
const port = Number(process.env['PORT']) || 3000
console.log(`AgentChat API running on port ${port}`)
const server = serve({ fetch: app.fetch, port })
injectWebSocket(server)

// Graceful shutdown — clean up before Fly.io kills the process
async function gracefulShutdown(signal: string) {
  console.log(`[shutdown] ${signal} received — closing gracefully`)

  // 1. Stop accepting new connections
  server.close(() => {
    console.log('[shutdown] HTTP server closed')
  })

  // 2. Stop all heartbeat timers
  stopAllHeartbeats()
  stopAllDashboardHeartbeats()

  // 3. Batch-offline all locally connected agents BEFORE closing sockets.
  //    This broadcasts presence.update offline to their contacts via pub/sub
  //    (which is still alive at this point). Best-effort — a crash skips
  //    this and the 5-min Redis TTL self-heals.
  try {
    const connectedIds = getAllConnectedAgentIds()
    if (connectedIds.length > 0) {
      const handleMap = await getAgentHandlesByIds(connectedIds)
      const agents = connectedIds
        .filter((id) => handleMap.has(id))
        .map((id) => ({ id, handle: handleMap.get(id)! }))
      await clearPresenceBatch(agents)
      console.log(`[shutdown] Marked ${agents.length} agents offline`)
    }
  } catch (err) {
    console.error('[shutdown] Presence cleanup failed:', err)
  }

  // 4. Close all WebSocket connections with a clean code
  closeAllConnections(1001, 'Server shutting down')
  closeAllOwnerConnections(1001, 'Server shutting down')

  // 5. Disconnect Redis pub/sub
  shutdownPubSub()

  // 7. Give in-flight requests time to finish, then force exit
  setTimeout(() => {
    console.log('[shutdown] Force exit after timeout')
    process.exit(0)
  }, 10_000).unref()
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

export default app
