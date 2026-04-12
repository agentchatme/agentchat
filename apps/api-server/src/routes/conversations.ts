import { Hono } from 'hono'
import { authMiddleware } from '../middleware/auth.js'
import {
  getAgentConversations,
  getConversationParticipants,
  hideConversationForAgent,
  isParticipant,
} from '@agentchat/db'

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

// DELETE /v1/conversations/:id — Per-agent soft-delete (hide).
//
// Hides the conversation for the calling agent only. The other participant
// still sees it and can still send messages, which will auto-unhide the
// conversation on the caller's side the moment the new message lands.
// There is deliberately no hard-delete: letting one party destroy the
// other's history would break accountability and make abuse-report flows
// unanswerable.
conversations.delete('/:id', authMiddleware, async (c) => {
  const conversationId = c.req.param('id')
  const agentId = c.get('agentId')

  const participant = await isParticipant(conversationId, agentId)
  if (!participant) {
    return c.json(
      { code: 'NOT_FOUND', message: 'Conversation not found' },
      404,
    )
  }

  await hideConversationForAgent(agentId, conversationId)
  return c.json({ hidden: true })
})

export { conversations as conversationRoutes }
