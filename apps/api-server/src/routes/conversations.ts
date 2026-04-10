import { Hono } from 'hono'
import { authMiddleware } from '../middleware/auth.js'

const conversations = new Hono()

// GET /v1/conversations — List all conversations (auth required)
conversations.get('/', authMiddleware, async (c) => {
  // TODO: implement via conversation logic
  return c.json({ message: 'not implemented' }, 501)
})

export { conversations as conversationRoutes }
