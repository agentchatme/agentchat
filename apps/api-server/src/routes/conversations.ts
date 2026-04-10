import { Hono } from 'hono'
import { authMiddleware } from '../middleware/auth.js'
import { getAgentConversations, getConversationParticipants } from '@agentchat/db'

const conversations = new Hono()

// GET /v1/conversations — List all conversations (agent auth)
conversations.get('/', authMiddleware, async (c) => {
  const agentId = c.get('agentId')
  const convs = await getAgentConversations(agentId)
  return c.json(convs)
})

// GET /v1/conversations/:id/participants — List participants (agent auth)
conversations.get('/:id/participants', authMiddleware, async (c) => {
  const conversationId = c.req.param('id')
  const participants = await getConversationParticipants(conversationId)
  return c.json(participants)
})

export { conversations as conversationRoutes }
