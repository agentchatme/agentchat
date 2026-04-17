import { Hono } from 'hono'
import { authMiddleware } from '../middleware/auth.js'
import {
  getAgentConversations,
  getConversationParticipants,
  hideConversationForAgent,
  isParticipant,
} from '@agentchat/db'
import { buildAvatarUrl } from '../services/avatar.service.js'

const conversations = new Hono()

// GET /v1/conversations — List all conversations (agent auth)
conversations.get('/', authMiddleware, async (c) => {
  const agentId = c.get('agentId')
  const convs = await getAgentConversations(agentId)
  // DB returns participants with internal `avatar_key`; translate to
  // wire-format `avatar_url` before responding so callers never see raw
  // storage paths.
  const wire = convs.map((conv) => ({
    ...conv,
    participants: conv.participants.map((p) => {
      const { avatar_key, ...rest } = p
      return {
        ...rest,
        avatar_url: buildAvatarUrl(avatar_key),
      }
    }),
  }))
  return c.json(wire)
})

// GET /v1/conversations/:id/participants — List participants (agent auth)
conversations.get('/:id/participants', authMiddleware, async (c) => {
  const conversationId = c.req.param('id')
  const participants = await getConversationParticipants(conversationId)
  const wire = participants.map((p) => {
    const { avatar_key, ...rest } = p
    return { ...rest, avatar_url: buildAvatarUrl(avatar_key) }
  })
  return c.json(wire)
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
