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
  isBlockedEither,
  isContact,
  findOrCreateDirectConversation,
  updateConversationLastMessage,
  isParticipant,
  getConversationParticipants,
  getConversation,
  markConversationEstablished,
  addContact,
} from '@agentchat/db'
import type { SendMessageRequest } from '@agentchat/shared'
import { checkColdOutreachCap, checkGlobalRateLimit } from './enforcement.service.js'
import { sendToAgent } from '../ws/events.js'
import { fireWebhooks } from './webhook.service.js'

const MAX_CONTENT_BYTES = 32_768 // 32 KB

export class MessageError extends Error {
  code: string
  status: number
  retryAfter?: number

  constructor(code: string, message: string, status: number, retryAfter?: number) {
    super(message)
    this.name = 'MessageError'
    this.code = code
    this.status = status
    this.retryAfter = retryAfter
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

  // 1. Resolve recipient by handle (must be first — everything depends on recipient.id)
  const recipient = await findAgentByHandle(req.to.replace(/^@/, '').toLowerCase())

  if (!recipient) {
    throw new MessageError('AGENT_NOT_FOUND', `Account ${req.to} not found`, 404)
  }

  if (recipient.id === senderId) {
    throw new MessageError('VALIDATION_ERROR', 'Cannot send a message to yourself', 400)
  }

  // 2. Parallel reads — all independent queries that only need senderId + recipient.id
  const [sender, blocked, existingConvId] = await Promise.all([
    findAgentById(senderId),
    isBlockedEither(senderId, recipient.id),
    findDirectConversation(senderId, recipient.id),
  ])

  // 3. Validate results from parallel reads
  if (!sender) {
    throw new MessageError('AGENT_NOT_FOUND', 'Sender account not found', 404)
  }
  if (sender.status === 'suspended') {
    throw new MessageError('SUSPENDED', 'Your account is suspended.', 403)
  }
  if (blocked) {
    throw new MessageError('BLOCKED', 'Messaging between these accounts is blocked', 403)
  }
  if (sender.status === 'restricted' && !existingConvId) {
    throw new MessageError(
      'RESTRICTED',
      'Your account is restricted to existing contacts only. Cold outreach is temporarily disabled. Restrictions are re-evaluated continuously and lift when the block count in the rolling 24-hour window drops below 15.',
      403,
    )
  }

  // 4. Check recipient's inbox mode
  const inboxMode = (recipient.settings as Record<string, unknown>)?.inbox_mode ?? 'open'
  if (inboxMode === 'contacts_only') {
    const isSenderInContacts = await isContact(recipient.id, senderId)
    if (!isSenderInContacts) {
      throw new MessageError(
        'INBOX_RESTRICTED',
        'This account only accepts messages from contacts',
        403,
      )
    }
  }

  // 5. Global per-second rate limit (flat 60/sec for all agents)
  const rateCheck = await checkGlobalRateLimit(senderId)
  if (!rateCheck.allowed) {
    throw new MessageError(
      'RATE_LIMITED',
      'Too many messages per second',
      429,
      rateCheck.retryAfterMs,
    )
  }

  // 6. Cold outreach cap (only for new conversations — 100/day, reply frees slot)
  if (!existingConvId) {
    const capCheck = await checkColdOutreachCap(senderId)
    if (!capCheck.allowed) {
      throw new MessageError(
        'RATE_LIMITED',
        `Daily cold outreach limit reached (${capCheck.limit}/day). Slots free up when recipients reply.`,
        429,
      )
    }
  }

  // 7. Atomically find or create conversation (safe against race conditions)
  const newConvId = generateId('conv')
  const { conversationId } = await findOrCreateDirectConversation(
    senderId,
    recipient.id,
    newConvId,
  )

  // 8. If sender is NOT the initiator, mark conversation as established
  //    (recipient replying → mutual conversation, frees up initiator's rate limit slot)
  //    Also auto-add each other as contacts (organic contact formation)
  if (existingConvId) {
    const conv = await getConversation(conversationId)
    if (conv && !conv.established && conv.initiated_by !== senderId) {
      await markConversationEstablished(conversationId)
      addContact(senderId, recipient.id).catch((err) => {
        console.error('[auto-contact] Failed to add sender→recipient contact:', err)
      })
      addContact(recipient.id, senderId).catch((err) => {
        console.error('[auto-contact] Failed to add recipient→sender contact:', err)
      })
    }
  }

  // 9. Store message + update timestamp in parallel (both only need conversationId)
  const messageId = generateId('msg')
  const [message] = await Promise.all([
    insertMessage({
      id: messageId,
      conversation_id: conversationId,
      sender_id: senderId,
      type: req.type ?? 'text',
      content: req.content as Record<string, unknown>,
      metadata: req.metadata as Record<string, unknown> | undefined,
      status: 'stored',
    }),
    updateConversationLastMessage(conversationId),
  ])

  // Map sender_id to sender handle BEFORE any external delivery
  const publicMessage = toPublicMessage(message, sender.handle)

  // 10. ASYNC PUSH — try real-time delivery (non-blocking, best-effort)
  pushToRecipient(recipient.id, publicMessage).catch(() => {
    // Push failed — that's fine, message is safe in DB
  })

  return publicMessage
}

/** Strip internal sender_id, replace with sender handle for API responses */
function toPublicMessage(msg: Record<string, unknown>, senderHandle: string) {
  const { sender_id: _, ...rest } = msg
  return { ...rest, sender: senderHandle }
}

/** Batch-resolve sender_ids to handles for a list of messages */
async function mapSenderHandles(messages: Array<Record<string, unknown>>) {
  if (messages.length === 0) return []
  const senderIds = [...new Set(messages.map((m) => m.sender_id as string))]
  const agents = await Promise.all(senderIds.map((id) => findAgentById(id)))
  const handleMap = new Map<string, string>()
  for (const agent of agents) {
    if (agent) handleMap.set(agent.id, agent.handle)
  }
  return messages.map((m) => toPublicMessage(m, handleMap.get(m.sender_id as string) ?? 'unknown'))
}

async function pushToRecipient(recipientId: string, message: Record<string, unknown>) {
  // Both paths fire in parallel — no gating on local connection state.
  // Pub/sub fans out to all servers; the server holding the WebSocket delivers + marks "delivered".
  // Webhooks fire independently as a parallel path (agents deduplicate by message ID).
  // Sync on reconnect is the final safety net for anything both paths miss.

  // Path 1: Real-time via pub/sub → WebSocket (all servers check local connections)
  sendToAgent(recipientId, {
    type: 'message.new',
    payload: message,
  })

  // Path 2: Webhook delivery (parallel, best-effort with retries)
  fireWebhooks(recipientId, 'message.new', message)
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

  const messages = await getConversationMessages(conversationId, limit, before)
  return mapSenderHandles(messages)
}

export async function markAsDelivered(messageId: string) {
  return updateMessageStatus(messageId, 'delivered')
}

export async function markAsRead(messageId: string, agentId: string) {
  const message = await updateMessageStatus(messageId, 'read')

  // Resolve reader's handle for external payload (never expose internal ID)
  const reader = await findAgentById(agentId)
  const readerHandle = reader?.handle ?? 'unknown'

  const readPayload = { message_id: messageId, read_by: readerHandle, read_at: message.read_at }

  if (message.sender_id) {
    // Route internally via sender_id, but payload uses handles only
    sendToAgent(message.sender_id, {
      type: 'message.read',
      payload: readPayload,
    })
    fireWebhooks(message.sender_id, 'message.read', readPayload)
  }

  // Map sender_id to handle in the response
  const senderAgent = await findAgentById(message.sender_id)
  return toPublicMessage(message, senderAgent?.handle ?? 'unknown')
}

const SYNC_BATCH_SIZE = 200

export async function syncUndelivered(agentId: string) {
  // Fetch undelivered messages but DON'T mark as delivered here.
  // The "delivered" status is set by deliverLocally in pubsub.ts
  // only after ws.send() actually succeeds.
  const messages = await getUndeliveredMessages(agentId, SYNC_BATCH_SIZE)
  return mapSenderHandles(messages)
}

export async function removeMessage(messageId: string, agentId: string) {
  const deleted = await deleteMessage(messageId, agentId)
  if (!deleted) {
    throw new MessageError('MESSAGE_NOT_FOUND', 'Message not found or you are not the sender', 404)
  }
}
