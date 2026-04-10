import { generateId } from '../lib/id.js'
import {
  findAgentByHandle,
  findAgentById,
  findDirectConversation,
  insertMessage,
  getConversationMessages,
  updateMessageStatus,
  getUndeliveredMessages,
  deleteMessage,
  isBlocked,
  findOrCreateDirectConversation,
  updateConversationLastMessage,
  isParticipant,
  getConversationParticipants,
} from '@agentchat/db'
import { NEW_CONVERSATIONS_PER_DAY, MESSAGES_PER_MINUTE } from '@agentchat/shared'
import type { SendMessageRequest } from '@agentchat/shared'
import { getTrustTier } from './trust.service.js'
import { getRedis } from '../lib/redis.js'
import { sendToAgent } from '../ws/events.js'
import { isOnline } from '../ws/registry.js'

const MAX_CONTENT_BYTES = 32_768 // 32 KB

export class MessageError extends Error {
  code: string
  status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'MessageError'
    this.code = code
    this.status = status
  }
}

export async function sendMessage(senderId: string, req: SendMessageRequest) {
  // 0. Validate content size
  const contentSize = Buffer.byteLength(JSON.stringify(req.content), 'utf8')
  if (contentSize > MAX_CONTENT_BYTES) {
    throw new MessageError(
      'CONTENT_TOO_LARGE',
      `Message content exceeds ${MAX_CONTENT_BYTES / 1024}KB limit`,
      413,
    )
  }

  // 1. Resolve recipient
  const recipient = req.to.startsWith('agt_')
    ? await findAgentById(req.to)
    : await findAgentByHandle(req.to.replace(/^@/, ''))

  if (!recipient) {
    throw new MessageError('AGENT_NOT_FOUND', `Agent ${req.to} not found`, 404)
  }

  if (recipient.id === senderId) {
    throw new MessageError('VALIDATION_ERROR', 'Cannot send a message to yourself', 400)
  }

  // 2. Check if sender is blocked by recipient
  const blocked = await isBlocked(recipient.id, senderId)
  if (blocked) {
    throw new MessageError('BLOCKED', 'You are blocked by this agent', 403)
  }

  // 3. Check if conversation already exists (read-only, no creation yet)
  const existingConvId = await findDirectConversation(senderId, recipient.id)

  // 4. Rate limit checks BEFORE creating anything
  const sender = await findAgentById(senderId)
  if (!sender) {
    throw new MessageError('AGENT_NOT_FOUND', 'Sender agent not found', 404)
  }
  const tier = getTrustTier(sender.trust_score)

  // 4a. If this would be a new conversation, check new-conversation rate limit
  if (!existingConvId) {
    const limit = NEW_CONVERSATIONS_PER_DAY[tier]
    const allowed = await checkNewConversationRateLimit(senderId, limit)
    if (!allowed) {
      throw new MessageError(
        'RATE_LIMITED',
        `Daily new conversation limit reached (${limit}/day for ${tier} tier)`,
        429,
      )
    }
  }

  // 4b. Per-conversation message rate limit (applies to all conversations)
  const convIdForRateLimit = existingConvId ?? 'pending'
  const msgLimit = MESSAGES_PER_MINUTE[tier]
  const msgAllowed = await checkMessageRateLimit(senderId, convIdForRateLimit, msgLimit)
  if (!msgAllowed) {
    throw new MessageError(
      'RATE_LIMITED',
      `Message rate limit exceeded (${msgLimit}/min for ${tier} tier)`,
      429,
    )
  }

  // 5. Atomically find or create conversation (safe against race conditions)
  const newConvId = generateId('conv')
  const { conversationId } = await findOrCreateDirectConversation(
    senderId,
    recipient.id,
    newConvId,
  )

  // 6. STORE FIRST — write to PostgreSQL (this is the durability guarantee)
  const messageId = generateId('msg')
  const message = await insertMessage({
    id: messageId,
    conversation_id: conversationId,
    sender_id: senderId,
    type: req.type ?? 'text',
    content: req.content as Record<string, unknown>,
    metadata: req.metadata as Record<string, unknown> | undefined,
    status: 'stored',
  })

  // 7. Update conversation timestamp
  await updateConversationLastMessage(conversationId)

  // 8. ASYNC PUSH — try real-time delivery (non-blocking, best-effort)
  //    This runs after we've already stored the message and will return 201
  pushToRecipient(recipient.id, message).catch(() => {
    // Push failed — that's fine, message is safe in DB
    // Recipient gets it on next sync
  })

  return message
}

async function pushToRecipient(recipientId: string, message: Record<string, unknown>) {
  if (isOnline(recipientId)) {
    sendToAgent(recipientId, {
      type: 'message.new',
      payload: message,
    })
    // Mark as delivered since recipient is connected
    await updateMessageStatus(message.id as string, 'delivered')
  }
  // If not online, message stays as 'stored' — delivered on next sync
}

async function checkNewConversationRateLimit(agentId: string, limit: number): Promise<boolean> {
  const redis = getRedis()
  const key = `ratelimit:newconv:${agentId}`
  const today = new Date().toISOString().split('T')[0]
  const dailyKey = `${key}:${today}`

  const current = await redis.incr(dailyKey)

  // Set expiry on first increment (24 hours)
  if (current === 1) {
    await redis.expire(dailyKey, 86400)
  }

  return current <= limit
}

async function checkMessageRateLimit(
  agentId: string,
  conversationId: string,
  limit: number,
): Promise<boolean> {
  const redis = getRedis()
  const minute = Math.floor(Date.now() / 60_000)
  const key = `ratelimit:msg:${agentId}:${conversationId}:${minute}`

  const current = await redis.incr(key)
  if (current === 1) {
    await redis.expire(key, 120) // 2 min TTL (covers current + overlap)
  }

  return current <= limit
}

export async function getMessages(
  agentId: string,
  conversationId: string,
  limit = 50,
  before?: string,
) {
  // Verify the requesting agent is a participant
  const participant = await isParticipant(conversationId, agentId)
  if (!participant) {
    throw new MessageError('FORBIDDEN', 'You are not a participant in this conversation', 403)
  }

  return getConversationMessages(conversationId, limit, before)
}

export async function markAsDelivered(messageId: string) {
  return updateMessageStatus(messageId, 'delivered')
}

export async function markAsRead(messageId: string, agentId: string) {
  // Update message status
  const message = await updateMessageStatus(messageId, 'read')

  // Notify sender that message was read (best-effort)
  if (message.sender_id && isOnline(message.sender_id)) {
    sendToAgent(message.sender_id, {
      type: 'message.read',
      payload: { message_id: messageId, read_by: agentId, read_at: message.read_at },
    })
  }

  return message
}

export async function syncUndelivered(agentId: string) {
  // Get all messages waiting for this agent
  const messages = await getUndeliveredMessages(agentId)

  // Mark them all as delivered
  for (const msg of messages) {
    await updateMessageStatus(msg.id, 'delivered').catch(() => {
      // Non-critical, continue with other messages
    })
  }

  return messages
}

export async function removeMessage(messageId: string, agentId: string) {
  await deleteMessage(messageId, agentId)
}
