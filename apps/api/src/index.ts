import { Hono } from 'hono'
import { serve } from '@hono/node-server'

const app = new Hono()

app.get('/', (c) => {
  return c.json({ name: 'AgentChat API', version: '0.1.0', status: 'alive' })
})

app.get('/v1/health', (c) => {
  return c.json({ status: 'ok' })
})

const port = Number(process.env.PORT) || 3000
console.log(`AgentChat API running on port ${port}`)
serve({ fetch: app.fetch, port })
