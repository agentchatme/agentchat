import './env.js' // Validate env vars immediately — crash on missing credentials
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createNodeWebSocket } from '@hono/node-ws'
import { serve } from '@hono/node-server'
import { registerRoutes } from './routes/register.js'
import { agentRoutes } from './routes/agents.js'
import { messageRoutes } from './routes/messages.js'
import { conversationRoutes } from './routes/conversations.js'
import { contactRoutes } from './routes/contacts.js'
import { presenceRoutes } from './routes/presence.js'
import { webhookRoutes } from './routes/webhooks.js'
import { directoryRoutes } from './routes/directory.js'
import { uploadRoutes } from './routes/uploads.js'
import { attachmentRoutes } from './routes/attachments.js'
import { metricsRoutes } from './routes/metrics.js'
import { errorHandler } from './middleware/error-handler.js'
import { requestLogger } from './middleware/logger.js'
import { authenticateWs, handleWsConnection, stopAllHeartbeats } from './ws/handler.js'
import { initPubSub, shutdownPubSub } from './ws/pubsub.js'
import { closeAllConnections } from './ws/registry.js'
import { startWebhookWorker, stopWebhookWorker } from './services/webhook-worker.js'

const app = new Hono()
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

// Global middleware
app.use('*', requestLogger)

// CORS — public API with API-key auth, so the origin header is NOT the
// authentication boundary (the API key is). Defaulting to "*" lets any
// browser-hosted agent call the API via fetch(), which matches how other
// public APIs (Stripe, Twilio) behave. Operators can lock it down by
// setting CORS_ORIGINS=https://app.example.com,https://staging.example.com
// when they want to restrict the dashboard or internal tooling.
//
// credentials: false — we never use cookies, only the Authorization header,
// so wildcard origin is actually allowed here (credentialed wildcard isn't).
//
// exposeHeaders: Retry-After so browser rate-limit responses can be read
// by the SDK — fetch() hides non-whitelisted response headers otherwise.
const corsOriginsRaw = process.env['CORS_ORIGINS']?.trim() ?? ''
const corsOrigin: string | string[] =
  corsOriginsRaw === '' || corsOriginsRaw === '*'
    ? '*'
    : corsOriginsRaw.split(',').map((s) => s.trim()).filter(Boolean)

app.use(
  '*',
  cors({
    origin: corsOrigin,
    allowHeaders: ['Authorization', 'Content-Type'],
    exposeHeaders: ['Retry-After'],
    maxAge: 600,
    credentials: false,
  }),
)

app.onError(errorHandler)

// Health check
app.get('/', (c) => {
  return c.json({ name: 'AgentChat API', version: '0.2.0', status: 'alive' })
})

app.get('/v1/health', (c) => {
  return c.json({ status: 'ok' })
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
    let upfrontAgentId: string | null = null
    if (authHeader?.startsWith('Bearer ')) {
      upfrontAgentId = await authenticateWs(authHeader.slice(7))
      if (!upfrontAgentId) {
        // Bad key — fail-closed, don't fall through to HELLO.
        return { onOpen: (_evt, ws) => { ws.close(1008, 'Invalid token') } }
      }
    }

    if (upfrontAgentId) {
      const agentId = upfrontAgentId
      return {
        onOpen: (_evt, ws) => {
          const { onClose } = handleWsConnection(agentId, ws)
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

          const id = await authenticateWs(data.api_key)
          if (!id) {
            try { ws.close(1008, 'Invalid token') } catch { /* already closed */ }
            return
          }

          if (helloTimeout) {
            clearTimeout(helloTimeout)
            helloTimeout = null
          }
          authenticated = true

          const { onClose } = handleWsConnection(id, ws)
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

// Mount routes
app.route('/v1/register', registerRoutes)
app.route('/v1/agents', agentRoutes)
app.route('/v1/messages', messageRoutes)
app.route('/v1/conversations', conversationRoutes)
app.route('/v1/contacts', contactRoutes)
app.route('/v1/presence', presenceRoutes)
app.route('/v1/webhooks', webhookRoutes)
app.route('/v1/directory', directoryRoutes)
app.route('/v1/uploads', uploadRoutes)
app.route('/v1/attachments', attachmentRoutes)
app.route('/v1/metrics', metricsRoutes)

// Initialize Redis pub/sub for multi-server WebSocket fan-out
initPubSub(process.env['REDIS_URL'])

// Start the durable webhook-delivery worker. It polls webhook_deliveries
// on an interval and uses FOR UPDATE SKIP LOCKED so multi-server deploys
// don't double-process the same row.
startWebhookWorker()

// Start server
const port = Number(process.env['PORT']) || 3000
console.log(`AgentChat API running on port ${port}`)
const server = serve({ fetch: app.fetch, port })
injectWebSocket(server)

// Graceful shutdown — clean up before Fly.io kills the process
function gracefulShutdown(signal: string) {
  console.log(`[shutdown] ${signal} received — closing gracefully`)

  // 1. Stop accepting new connections
  server.close(() => {
    console.log('[shutdown] HTTP server closed')
  })

  // 2. Stop all heartbeat timers
  stopAllHeartbeats()

  // 3. Close all WebSocket connections with a clean code
  closeAllConnections(1001, 'Server shutting down')

  // 4. Stop the webhook worker polling loop. Any in-flight fetches will
  //    complete within their 10s timeout; rows claimed but not finalized
  //    before shutdown will be reclaimed by the next worker after the 60s
  //    stale-delivering cutoff in claim_webhook_deliveries.
  stopWebhookWorker()

  // 5. Disconnect Redis pub/sub
  shutdownPubSub()

  // 5. Give in-flight requests time to finish, then force exit
  setTimeout(() => {
    console.log('[shutdown] Force exit after timeout')
    process.exit(0)
  }, 10_000).unref()
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

export default app
