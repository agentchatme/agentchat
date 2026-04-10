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
  isContact,
  findOrCreateDirectConversation,
  updateConversationLastMessage,
  isParticipant,
  getConversationParticipants,
  countColdOutreaches,
  getConversation,
  markConversationEstablished,
  addContact,
} from '@agentchat/db'
import { NEW_CONVERSATIONS_PER_DAY, MESSAGES_PER_SECOND } from '@agentchat/shared'
import type { SendMessageRequest } from '@agentchat/shared'
import { getTrustTier } from './trust.service.js'
import { getRedis } from '../lib/redis.js'
import { sendToAgent } from '../ws/events.js'
import { isOnline } from '../ws/registry.js'
import { fireWebhooks } from './webhook.service.js'

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

  // 2. Check recipient's inbox mode
  const inboxMode = (recipient.settings as Record<string, unknown>)?.inbox_mode ?? 'open'
  if (inboxMode === 'contacts_only') {
    const isSenderInContacts = await isContact(recipient.id, senderId)
    if (!isSenderInContacts) {
      throw new MessageError(
        'INBOX_RESTRICTED',
        'This agent only accepts messages from contacts',
        403,
      )
    }
  } else if (inboxMode === 'verified_only') {
    const sender = await findAgentById(senderId)
    const senderTier = getTrustTier(sender?.trust_score ?? 0)
    if (senderTier !== 'verified' && senderTier !== 'established') {
      throw new MessageError(
        'INBOX_RESTRICTED',
        'This agent only accepts messages from verified agents',
        403,
      )
    }
  }

  // 3. Check if sender is blocked by recipient
  const blocked = await isBlocked(recipient.id, senderId)
  if (blocked) {
    throw new MessageError('BLOCKED', 'You are blocked by this agent', 403)
  }

  // 4. Check sender status (suspended/restricted agents can't cold-message)
  const sender = await findAgentById(senderId)
  if (!sender) {
    throw new MessageError('AGENT_NOT_FOUND', 'Sender agent not found', 404)
  }
  if (sender.status === 'suspended') {
    throw new MessageError('SUSPENDED', 'Your agent is suspended', 403)
  }

  const tier = getTrustTier(sender.trust_score)

  // 5. Per-second rate limit (protects infrastructure)
  const perSecLimit = MESSAGES_PER_SECOND[tier]
  const perSecAllowed = await checkPerSecondRateLimit(senderId, perSecLimit)
  if (!perSecAllowed) {
    throw new MessageError(
      'RATE_LIMITED',
      `Too many messages per second (${perSecLimit}/sec limit for ${tier} tier)`,
      429,
    )
  }

  // 6. Check if conversation already exists (read-only, no creation yet)
  const existingConvId = await findDirectConversation(senderId, recipient.id)

  // 7. Cold outreach rate limit (only for new conversations)
  if (!existingConvId) {
    // Restricted agents (trust score <= 0) can't start new conversations
    if (sender.trust_score <= 0) {
      throw new MessageError(
        'RESTRICTED',
        'Your agent is restricted due to low trust score. You can only message existing contacts.',
        403,
      )
    }

    const limit = NEW_CONVERSATIONS_PER_DAY[tier]
    const coldCount = await countColdOutreaches(senderId)
    if (coldCount >= limit) {
      throw new MessageError(
        'RATE_LIMITED',
        `Daily new agent outreach limit reached (${limit}/day for ${tier} tier). Limit frees up when recipients reply.`,
        429,
      )
    }
  }

  // 8. Atomically find or create conversation (safe against race conditions)
  const newConvId = generateId('conv')
  const { conversationId } = await findOrCreateDirectConversation(
    senderId,
    recipient.id,
    newConvId,
  )

  // 9. If sender is NOT the initiator, mark conversation as established
  //    (recipient replying → mutual conversation, frees up initiator's rate limit slot)
  //    Also auto-add each other as contacts (organic contact formation)
  if (existingConvId) {
    const conv = await getConversation(conversationId)
    if (conv && !conv.established && conv.initiated_by !== senderId) {
      await markConversationEstablished(conversationId)
      // Auto-add mutual contacts (both directions, fire-and-forget)
      addContact(senderId, recipient.id).catch(() => {})
      addContact(recipient.id, senderId).catch(() => {})
    }
  }

  // 10. STORE FIRST — write to PostgreSQL (this is the durability guarantee)
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

  // 11. Update conversation timestamp
  await updateConversationLastMessage(conversationId)

  // 12. ASYNC PUSH — try real-time delivery (non-blocking, best-effort)
  pushToRecipient(recipient.id, message).catch(() => {
    // Push failed — that's fine, message is safe in DB
  })

  return message
}

async function pushToRecipient(recipientId: string, message: Record<string, unknown>) {
  if (isOnline(recipientId)) {
    // Agent is connected via WebSocket — push directly
    sendToAgent(recipientId, {
      type: 'message.new',
      payload: message,
    })
    await updateMessageStatus(message.id as string, 'delivered')
  } else {
    // Agent is offline — try webhook delivery (best-effort with retries)
    fireWebhooks(recipientId, 'message.new', message)
  }
}

async function checkPerSecondRateLimit(agentId: string, limit: number): Promise<boolean> {
  const redis = getRedis()
  const second = Math.floor(Date.now() / 1000)
  const key = `ratelimit:persec:${agentId}:${second}`

  const current = await redis.incr(key)
  if (current === 1) {
    await redis.expire(key, 3) // 3s TTL (covers current + buffer)
  }

  return current <= limit
}

export async function getMessages(
  agentId: string,
  conversationId: string,
  limit = 50,
  before?: string,
) {
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
  const message = await updateMessageStatus(messageId, 'read')

  const readPayload = { message_id: messageId, read_by: agentId, read_at: message.read_at }

  if (message.sender_id) {
    if (isOnline(message.sender_id)) {
      sendToAgent(message.sender_id, {
        type: 'message.read',
        payload: readPayload,
      })
    } else {
      fireWebhooks(message.sender_id, 'message.read', readPayload)
    }
  }

  return message
}

export async function syncUndelivered(agentId: string) {
  const messages = await getUndeliveredMessages(agentId)

  for (const msg of messages) {
    await updateMessageStatus(msg.id, 'delivered').catch(() => {})
  }

  return messages
}

export async function removeMessage(messageId: string, agentId: string) {
  await deleteMessage(messageId, agentId)
}
