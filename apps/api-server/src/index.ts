import './env.js' // Validate env vars immediately — crash on missing credentials
import { Hono } from 'hono'
import { createNodeWebSocket } from '@hono/node-ws'
import { serve } from '@hono/node-server'
import { registerRoutes } from './routes/register.js'
import { agentRoutes } from './routes/agents.js'
import { messageRoutes } from './routes/messages.js'
import { conversationRoutes } from './routes/conversations.js'
import { contactRoutes } from './routes/contacts.js'
import { presenceRoutes } from './routes/presence.js'
import { webhookRoutes } from './routes/webhooks.js'
import { errorHandler } from './middleware/error-handler.js'
import { requestLogger } from './middleware/logger.js'
import { authenticateWs, handleWsConnection, stopAllHeartbeats } from './ws/handler.js'
import { initPubSub, shutdownPubSub } from './ws/pubsub.js'
import { closeAllConnections } from './ws/registry.js'

const app = new Hono()
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

// Global middleware
app.use('*', requestLogger)
app.onError(errorHandler)

// Health check
app.get('/', (c) => {
  return c.json({ name: 'AgentChat API', version: '0.2.0', status: 'alive' })
})

app.get('/v1/health', (c) => {
  return c.json({ status: 'ok' })
})

// WebSocket endpoint
app.get(
  '/v1/ws',
  upgradeWebSocket(async (c) => {
    const token = c.req.query('token')
    if (!token) {
      return { onOpen: (_evt, ws) => { ws.close(1008, 'Missing token') } }
    }

    const agentId = await authenticateWs(token)
    if (!agentId) {
      return { onOpen: (_evt, ws) => { ws.close(1008, 'Invalid token') } }
    }

    return {
      onOpen: (_evt, ws) => {
        const { onClose } = handleWsConnection(agentId, ws)
        ws.raw?.addEventListener('close', onClose)
      },
      onMessage: (evt, ws) => {
        try {
          const data = JSON.parse(String(evt.data))
          // Future: handle client actions here (typing, read acks)
        } catch {
          // Invalid JSON — ignore
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

// Initialize Redis pub/sub for multi-server WebSocket fan-out
initPubSub(process.env['REDIS_URL'])

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

  // 4. Disconnect Redis pub/sub
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
