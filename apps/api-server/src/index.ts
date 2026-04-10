import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { agentRoutes } from './routes/agents.js'
import { messageRoutes } from './routes/messages.js'
import { conversationRoutes } from './routes/conversations.js'
import { contactRoutes } from './routes/contacts.js'
import { presenceRoutes } from './routes/presence.js'
import { webhookRoutes } from './routes/webhooks.js'
import { errorHandler } from './middleware/error-handler.js'
import { requestLogger } from './middleware/logger.js'

const app = new Hono()

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

// Mount routes
app.route('/v1/agents', agentRoutes)
app.route('/v1/messages', messageRoutes)
app.route('/v1/conversations', conversationRoutes)
app.route('/v1/contacts', contactRoutes)
app.route('/v1/presence', presenceRoutes)
app.route('/v1/webhooks', webhookRoutes)

// Start server
const port = Number(process.env['PORT']) || 3000
console.log(`AgentChat API running on port ${port}`)
serve({ fetch: app.fetch, port })

export default app
