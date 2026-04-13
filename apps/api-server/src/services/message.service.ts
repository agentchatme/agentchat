import { generateId } from '../lib/id.js'
import {
  findAgentByHandle,
  findAgentById,
  findDirectConversation,
  atomicSendMessage,
  getConversationMessages,
  getConversationHide,
  getMessageById,
  updateDeliveryStatus,
  getUndeliveredMessages,
  ackDeliveries,
  hideMessageForAgent,
  isBlockedEither,
  isContact,
  findOrCreateDirectConversation,
  isParticipant,
  getConversation,
  markConversationEstablished,
  addContact,
  findGroupById,
  getGroupParticipantRole,
  getGroupParticipantJoinedSeq,
  getGroupPushRecipients,
  getAttachmentById,
} from '@agentchat/db'
import type { SendMessageRequest } from '@agentchat/shared'
import { checkColdOutreachCap, checkGlobalRateLimit } from './enforcement.service.js'
import { sendToAgent } from '../ws/events.js'
import { fireWebhooks } from './webhook.service.js'
import { messagesSent, messagesSendRejected, rateLimitHits } from '../lib/metrics.js'
import { resolveDeletedGroupInfoForCaller } from './group.service.js'

const MAX_PAYLOAD_BYTES = 32_768 // 32 KB — content + metadata combined

/**
 * Enforce that an attachment referenced by a message is scoped to the same
 * conversation the message is being sent into, and was uploaded by the same
 * sender. This closes three separate leaks that would otherwise be possible:
 *
 *   1. Hotlinking: sender references an attachment they didn't upload,
 *      piggybacking on access control that was granted to a different pair.
 *   2. Cross-conversation leakage: sender uploads a file to conversation A
 *      and then references its id in a message to conversation B, where
 *      the recipient set is different.
 *   3. Mode mismatch: a direct-scoped attachment (recipient_id set) is
 *      referenced inside a group message, or a group-scoped attachment
 *      (conversation_id set) is referenced inside a direct message — in
 *      both cases the download check would route to the wrong branch and
 *      silently deny every intended recipient.
 *
 * Called from both sendDirectMessage and sendGroupMessage, before the
 * atomic insert so a failed validation produces a clean 4xx with no side
 * effects on the messages table.
 */
async function assertAttachmentScope(
  attachmentId: string,
  senderId: string,
  target:
    | { kind: 'direct'; counterpartyId: string }
    | { kind: 'group'; conversationId: string },
) {
  const att = await getAttachmentById(attachmentId)
  // Non-existent or sender-mismatch both collapse to the same 404. A sender
  // has no legitimate reason to discover that someone else's attachment id
  // exists, so we don't distinguish the two.
  if (!att || att.uploader_id !== senderId) {
    messagesSendRejected.inc({ reason: 'attachment_not_found' })
    throw new MessageError(
      'ATTACHMENT_NOT_FOUND',
      'Referenced attachment does not exist or was not uploaded by you',
      404,
    )
  }
  if (target.kind === 'group') {
    if (att.conversation_id !== target.conversationId) {
      messagesSendRejected.inc({ reason: 'attachment_wrong_scope' })
      throw new MessageError(
        'ATTACHMENT_WRONG_SCOPE',
        'Attachment is not scoped to this group',
        400,
      )
    }
  } else {
    if (att.conversation_id !== null || att.recipient_id !== target.counterpartyId) {
      messagesSendRejected.inc({ reason: 'attachment_wrong_scope' })
      throw new MessageError(
        'ATTACHMENT_WRONG_SCOPE',
        'Attachment is not addressed to this recipient',
        400,
      )
    }
  }
}

export class MessageError extends Error {
  code: string
  status: number
  retryAfter?: number
  // Optional structured payload. Mirrors GroupError.details — used for
  // GROUP_DELETED (410) on the group send + history paths so the SDK can
  // render "group was deleted by @alice" with no extra round-trip.
  details?: Record<string, unknown>

  constructor(
    code: string,
    message: string,
    status: number,
    retryAfter?: number,
    details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'MessageError'
    this.code = code
    this.status = status
    this.retryAfter = retryAfter
    this.details = details
  }
}

export async function sendMessage(senderId: string, req: SendMessageRequest) {
  // 0. Combined content+metadata cap. Both travel to the recipient and are
  //    stored, so a misbehaving sender could otherwise bypass the limit by
  //    stuffing a large blob into `metadata`.
  const payloadSize =
    Buffer.byteLength(JSON.stringify(req.content), 'utf8') +
    (req.metadata ? Buffer.byteLength(JSON.stringify(req.metadata), 'utf8') : 0)
  if (payloadSize > MAX_PAYLOAD_BYTES) {
    messagesSendRejected.inc({ reason: 'too_large' })
    throw new MessageError(
      'CONTENT_TOO_LARGE',
      `Message content + metadata exceeds ${MAX_PAYLOAD_BYTES / 1024}KB limit`,
      413,
    )
  }

  // SendMessageRequest enforces exactly-one-of(to, conversation_id) via
  // its refine; at this point one is set. We branch on that to pick the
  // right enforcement policy. Direct sends pay cold-outreach + block +
  // inbox_mode costs; group sends pay only rate limit + size + idempotency
  // because group membership already is the consent that would otherwise
  // be enforced by those checks.
  if (req.conversation_id !== undefined) {
    return sendGroupMessage(senderId, req.conversation_id, req)
  }
  return sendDirectMessage(senderId, req.to as string, req)
}

async function sendDirectMessage(
  senderId: string,
  rawTo: string,
  req: SendMessageRequest,
) {
  // 1. Resolve recipient by handle (must be first — everything depends on recipient.id)
  const recipient = await findAgentByHandle(rawTo.replace(/^@/, '').toLowerCase())

  if (!recipient) {
    messagesSendRejected.inc({ reason: 'recipient_not_found' })
    throw new MessageError('AGENT_NOT_FOUND', `Account ${rawTo} not found`, 404)
  }

  if (recipient.id === senderId) {
    messagesSendRejected.inc({ reason: 'self_send' })
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
    messagesSendRejected.inc({ reason: 'sender_not_found' })
    throw new MessageError('AGENT_NOT_FOUND', 'Sender account not found', 404)
  }
  if (sender.status === 'suspended') {
    messagesSendRejected.inc({ reason: 'suspended' })
    throw new MessageError('SUSPENDED', 'Your account is suspended.', 403)
  }
  if (blocked) {
    messagesSendRejected.inc({ reason: 'blocked' })
    throw new MessageError('BLOCKED', 'Messaging between these accounts is blocked', 403)
  }
  if (sender.status === 'restricted' && !existingConvId) {
    messagesSendRejected.inc({ reason: 'restricted' })
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
      messagesSendRejected.inc({ reason: 'inbox_restricted' })
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
    rateLimitHits.inc({ rule: 'global' })
    messagesSendRejected.inc({ reason: 'rate_limited' })
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
      rateLimitHits.inc({ rule: 'cold_outreach' })
      messagesSendRejected.inc({ reason: 'cold_outreach_cap' })
      throw new MessageError(
        'RATE_LIMITED',
        `Daily cold outreach limit reached (${capCheck.limit}/day). Slots free up when recipients reply.`,
        429,
      )
    }
  }

  // 7. If the message references an attachment, enforce it belongs to this
  //    sender AND is scoped to this direct pair. Do this BEFORE creating
  //    the conversation so a cross-scope reference doesn't leave a dangling
  //    conversation row behind on rejection.
  const attachmentId =
    typeof req.content === 'object' && req.content !== null
      ? (req.content as { attachment_id?: unknown }).attachment_id
      : undefined
  if (typeof attachmentId === 'string') {
    await assertAttachmentScope(attachmentId, senderId, {
      kind: 'direct',
      counterpartyId: recipient.id,
    })
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
      addContact(senderId, recipient.id).catch((err) => {
        console.error('[auto-contact] Failed to add sender→recipient contact:', err)
      })
      addContact(recipient.id, senderId).catch((err) => {
        console.error('[auto-contact] Failed to add recipient→sender contact:', err)
      })
    }
  }

  // 10. Store message via atomic RPC — idempotency fast-path, seq allocation,
  //     and last_message_at update all happen inside send_message_atomic.
  const messageId = generateId('msg')
  const message = await atomicSendMessage({
    id: messageId,
    conversation_id: conversationId,
    sender_id: senderId,
    client_msg_id: req.client_msg_id,
    type: req.type ?? 'text',
    content: req.content as Record<string, unknown>,
    metadata: req.metadata as Record<string, unknown> | undefined,
  })

  // Map sender_id to sender handle BEFORE any external delivery
  const publicMessage = toPublicMessage(message, sender.handle)

  // 10. ASYNC PUSH — only fire on first write, not on idempotent replay.
  //    Replaying a delivered message would double-deliver to the recipient.
  if (!message.is_replay) {
    messagesSent.inc({ outcome: 'ok' })
    pushToRecipient(recipient.id, publicMessage).catch(() => {
      // Push failed — that's fine, message is safe in DB
    })
  } else {
    messagesSent.inc({ outcome: 'replay' })
  }

  return { message: publicMessage, isReplay: message.is_replay }
}

// Group send path. Skips cold-outreach, block, and inbox_mode checks
// because group membership IS the consent — those guardrails are spent
// at group-invite time by the group service. We still enforce:
//   - sender is an active participant (not just a former member)
//   - sender is not suspended
//   - per-second global rate limit
//   - size / idempotency (already handled by the RPC)
// Group membership of 100 means a single send fans out to 99 envelopes
// + 99 WS publishes + 99 webhook enqueues; the rate limit is the knob
// that keeps that fan-out bounded.
async function sendGroupMessage(
  senderId: string,
  conversationId: string,
  req: SendMessageRequest,
) {
  const group = await findGroupById(conversationId)
  if (!group) {
    // Could be a direct conversation id by mistake — reject with a
    // specific error so the client knows to use `to` instead.
    const conv = await getConversation(conversationId).catch(() => null)
    if (conv && conv.type === 'direct') {
      messagesSendRejected.inc({ reason: 'wrong_conv_type' })
      throw new MessageError(
        'VALIDATION_ERROR',
        'Use `to` to send to a direct conversation',
        400,
      )
    }
    messagesSendRejected.inc({ reason: 'group_not_found' })
    throw new MessageError('GROUP_NOT_FOUND', 'Group not found', 404)
  }

  // Deleted-group check: former members get a 410 with DeletedGroupInfo
  // so the client can render "group was deleted by @alice" instead of a
  // confusing "not found". Non-members fall through to the role check
  // below and get the usual masked 404.
  if (group.deleted_at) {
    const deletedCheck = await resolveDeletedGroupInfoForCaller(
      conversationId,
      senderId,
    )
    if (deletedCheck?.kind === 'gone') {
      messagesSendRejected.inc({ reason: 'group_deleted' })
      throw new MessageError(
        'GROUP_DELETED',
        'Group has been deleted',
        410,
        undefined,
        deletedCheck.info as unknown as Record<string, unknown>,
      )
    }
    messagesSendRejected.inc({ reason: 'group_not_found' })
    throw new MessageError('GROUP_NOT_FOUND', 'Group not found', 404)
  }

  const [sender, role] = await Promise.all([
    findAgentById(senderId),
    getGroupParticipantRole(conversationId, senderId),
  ])

  if (!sender) {
    messagesSendRejected.inc({ reason: 'sender_not_found' })
    throw new MessageError('AGENT_NOT_FOUND', 'Sender account not found', 404)
  }
  if (sender.status === 'suspended') {
    messagesSendRejected.inc({ reason: 'suspended' })
    throw new MessageError('SUSPENDED', 'Your account is suspended.', 403)
  }
  if (!role) {
    // Hide existence of the group from non-members.
    messagesSendRejected.inc({ reason: 'group_not_member' })
    throw new MessageError('GROUP_NOT_FOUND', 'Group not found', 404)
  }

  const rateCheck = await checkGlobalRateLimit(senderId)
  if (!rateCheck.allowed) {
    rateLimitHits.inc({ rule: 'global' })
    messagesSendRejected.inc({ reason: 'rate_limited' })
    throw new MessageError(
      'RATE_LIMITED',
      'Too many messages per second',
      429,
      rateCheck.retryAfterMs,
    )
  }

  // Cross-check any referenced attachment is scoped to THIS group and was
  // uploaded by the sender. Stops a sender from hotlinking a direct-scoped
  // attachment (or someone else's group file) into a group message.
  const attachmentId =
    typeof req.content === 'object' && req.content !== null
      ? (req.content as { attachment_id?: unknown }).attachment_id
      : undefined
  if (typeof attachmentId === 'string') {
    await assertAttachmentScope(attachmentId, senderId, {
      kind: 'group',
      conversationId,
    })
  }

  const messageId = generateId('msg')
  const message = await atomicSendMessage({
    id: messageId,
    conversation_id: conversationId,
    sender_id: senderId,
    client_msg_id: req.client_msg_id,
    type: req.type ?? 'text',
    content: req.content as Record<string, unknown>,
    metadata: req.metadata as Record<string, unknown> | undefined,
  })

  const publicMessage = toPublicMessage(message, sender.handle)

  if (!message.is_replay) {
    messagesSent.inc({ outcome: 'ok' })
    // Async fan-out to all active members except the sender. Recipient set
    // is filtered by `joined_seq <= message.seq` so that a member who
    // joined AFTER send_message_atomic committed (but before this async
    // push fires) does not receive a ghost `message.new` event for a
    // message their history cutoff would hide. The DB envelopes already
    // exclude them — this query mirrors the same rule for the ephemeral
    // push so the two stay consistent.
    pushToGroup(conversationId, senderId, message.seq, publicMessage).catch(
      () => {
        // Push failed — DB state is durable, sync/WS reconnect recovers it
      },
    )
  } else {
    messagesSent.inc({ outcome: 'replay' })
  }

  return { message: publicMessage, isReplay: message.is_replay }
}

// Exported for unit testing. Call site is local; nothing outside this
// module should depend on the signature.
export async function pushToGroup(
  conversationId: string,
  senderId: string,
  messageSeq: number,
  message: Record<string, unknown>,
) {
  // Single round-trip: active, non-departed, non-late-joiner, non-sender.
  // Returns agent ids directly so we avoid the handle→agent N+1 roundtrip
  // the previous implementation did through findAgentByHandle.
  const recipientIds = await getGroupPushRecipients(
    conversationId,
    messageSeq,
    senderId,
  )
  for (const agentId of recipientIds) {
    sendToAgent(agentId, {
      type: 'message.new',
      payload: message,
    })
    fireWebhooks(agentId, 'message.new', message)
  }
}

/** Strip internal sender_id (and internal is_replay flag), replace sender_id
 *  with the public sender handle. */
function toPublicMessage(msg: Record<string, unknown>, senderHandle: string) {
  const { sender_id: _sender, is_replay: _replay, ...rest } = msg
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
  beforeSeq?: number,
) {
  // Deleted-group short-circuit: former members read as 410 with
  // DeletedGroupInfo so the client can render "group was deleted by
  // @alice" on the detail screen they're still on. Non-members fall
  // through to the participant check below, which will 403 them.
  const deletedCheck = await resolveDeletedGroupInfoForCaller(
    conversationId,
    agentId,
  )
  if (deletedCheck?.kind === 'gone') {
    throw new MessageError(
      'GROUP_DELETED',
      'Group has been deleted',
      410,
      undefined,
      deletedCheck.info as unknown as Record<string, unknown>,
    )
  }

  // Resolve the conversation + participation in one shot so we can
  // apply group-specific rules (joined_seq, per-recipient delivery
  // scoping) without a second round-trip.
  const participant = await getParticipantContext(conversationId, agentId)
  if (!participant) {
    throw new MessageError('FORBIDDEN', 'You are not a participant in this conversation', 403)
  }

  // Honor this agent's soft-delete cutoff — messages with created_at <=
  // hidden_at are masked for them, but remain visible to the other side.
  // Also drops per-message hides (delete-for-me) for this agent.
  const hiddenAfter = await getConversationHide(agentId, conversationId)
  const messages = await getConversationMessages(
    conversationId,
    agentId,
    limit,
    beforeSeq,
    hiddenAfter,
    {
      joinedSeq: participant.joinedSeq,
      scopeToRecipient: participant.conversationType === 'group',
    },
  )
  return mapSenderHandles(messages)
}

// Lightweight wrapper around conversations/conversation_participants that
// returns just the fields message-history needs: whether the caller is
// still active, the conversation type, and their joined_seq. Returns
// null if they've never been a participant OR have left the conversation
// — both cases should 403 the caller.
async function getParticipantContext(
  conversationId: string,
  agentId: string,
): Promise<
  | {
      conversationType: 'direct' | 'group'
      joinedSeq: number
    }
  | null
> {
  const conv = await getConversation(conversationId).catch(() => null)
  if (!conv) return null
  const type = conv.type as 'direct' | 'group'

  if (type === 'direct') {
    const active = await isParticipant(conversationId, agentId)
    if (!active) return null
    // Direct conversations have no join cutoff — both parties see the
    // full history. Using 0 as joinedSeq is a no-op filter.
    return { conversationType: 'direct', joinedSeq: 0 }
  }

  // For groups we need the stored joined_seq so the caller only sees
  // messages at or after their join point.
  const joinedSeq = await getGroupParticipantJoinedSeq(conversationId, agentId)
  if (joinedSeq === null) return null
  return { conversationType: 'group', joinedSeq }
}

export async function markAsRead(messageId: string, agentId: string) {
  // Update the caller's own delivery envelope. Null means no such envelope
  // exists — the agent is not a recipient of this message (or the id is bogus).
  const delivery = await updateDeliveryStatus(messageId, agentId, 'read')
  if (!delivery) {
    throw new MessageError(
      'MESSAGE_NOT_FOUND',
      'Message not found or you are not a recipient',
      404,
    )
  }

  const message = await getMessageById(messageId)
  if (!message) {
    throw new MessageError('MESSAGE_NOT_FOUND', 'Message not found', 404)
  }

  const reader = await findAgentById(agentId)
  const readerHandle = reader?.handle ?? 'unknown'
  const readPayload = {
    message_id: messageId,
    read_by: readerHandle,
    read_at: delivery.read_at,
  }

  const senderId = message.sender_id as string
  // Route internally via sender_id, but payload uses handles only
  sendToAgent(senderId, { type: 'message.read', payload: readPayload })
  fireWebhooks(senderId, 'message.read', readPayload)

  const senderAgent = await findAgentById(senderId)
  const composed = {
    ...message,
    status: delivery.status,
    delivered_at: delivery.delivered_at,
    read_at: delivery.read_at,
  }
  return toPublicMessage(composed, senderAgent?.handle ?? 'unknown')
}

const SYNC_BATCH_SIZE = 200
const MAX_SYNC_LIMIT = 500

export async function syncUndelivered(
  agentId: string,
  opts: { after?: string; limit?: number } = {},
) {
  // Fetch undelivered messages but DON'T mark as delivered here.
  // For the WS drain path, deliverLocally marks delivered after ws.send()
  // succeeds. For the HTTP sync path, the client calls /sync/ack to
  // explicitly commit a batch — this is how partial-failure during client
  // processing is handled without silently discarding messages.
  const rawLimit = opts.limit ?? SYNC_BATCH_SIZE
  const limit = Math.max(1, Math.min(rawLimit, MAX_SYNC_LIMIT))
  const messages = await getUndeliveredMessages(agentId, limit, opts.after)
  return mapSenderHandles(messages)
}

/**
 * Explicitly mark everything up to and including the given delivery cursor
 * as 'delivered' for this agent. Used by the HTTP sync/ack flow — see
 * getUndeliveredMessages for the cursor semantics.
 *
 * Returns the count of rows that transitioned from 'stored' to 'delivered'.
 * Callers receive 0 when the cursor is malformed or doesn't resolve — let
 * the HTTP layer decide whether that's an error or a no-op.
 */
export async function ackDelivered(
  agentId: string,
  lastDeliveryId: string,
): Promise<number> {
  return ackDeliveries(agentId, lastDeliveryId)
}

/**
 * Hide-for-me. Removes the message from the caller's own view only.
 * Either side (sender OR recipient) may call this; the other side's
 * copy is untouched and remains fully visible in their conversation
 * history, sync drain, and any subsequent report-for-abuse flow.
 *
 * This is the ONLY message deletion path in AgentChat. There is no
 * delete-for-everyone. The invariant exists so a malicious sender
 * can't retract spam, scam, or phishing content after a recipient
 * has seen it — the recipient's copy has to survive for moderation
 * review even if the sender "deletes" the message from their own
 * outbox.
 *
 * Idempotent: hiding an already-hidden message is a success no-op.
 */
export async function hideMessageForMe(messageId: string, agentId: string) {
  const message = await getMessageById(messageId)
  if (!message) {
    throw new MessageError('MESSAGE_NOT_FOUND', 'Message not found', 404)
  }

  const conversationId = message.conversation_id as string
  const participant = await isParticipant(conversationId, agentId)
  if (!participant) {
    throw new MessageError(
      'FORBIDDEN',
      'You are not a participant in this conversation',
      403,
    )
  }

  await hideMessageForAgent(messageId, agentId)
}
