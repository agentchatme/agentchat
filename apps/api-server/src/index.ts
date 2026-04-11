import './env.js' // Validate env vars immediately — crash on missing credentials
import { Hono } from 'hono'
import { createNodeWebSocket } from '@hono/node-ws'
import { serve } from '@hono/node-server'
import { authRoutes } from './routes/auth.js'
import { agentRoutes } from './routes/agents.js'
import { messageRoutes } from './routes/messages.js'
import { conversationRoutes } from './routes/conversations.js'
import { contactRoutes } from './routes/contacts.js'
import { presenceRoutes } from './routes/presence.js'
import { webhookRoutes } from './routes/webhooks.js'
import { errorHandler } from './middleware/error-handler.js'
import { requestLogger } from './middleware/logger.js'
import { authenticateWs, handleWsConnection } from './ws/handler.js'
import { initPubSub } from './ws/pubsub.js'

const app = new Hono()
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

// Global middleware
app.use('*', requestLogger)
app.onError(errorHandler)

// Health check
app.get('/', (c) => {
  return c.json({ name: 'AgentChat API', version: '0.1.0', status: 'alive' })
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
        // Handle client actions (typing, read acks, etc.)
        try {
          const data = JSON.parse(String(evt.data))
          // Future: handle client actions here
        } catch {
          // Invalid JSON — ignore
        }
      },
    }
  }),
)

// Mount routes
app.route('/v1/auth', authRoutes)
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

export default app
