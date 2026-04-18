import { generateId } from '../lib/id.js'
import {
  findAgentByHandle,
  findAgentById,
  findDirectConversation,
  atomicSendMessage,
  RecipientBackloggedError,
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
  hasParticipantHistory,
  getConversation,
  markConversationEstablished,
  addContact,
  findGroupById,
  getGroupParticipantRole,
  getGroupParticipantJoinedSeq,
  getGroupPushRecipients,
  getAttachmentById,
  listFullyPausedAgentIds,
  findOwnerIdForAgent,
  getAgentHandlesByIds,
} from '@agentchat/db'
import type { SendMessageRequest } from '@agentchat/shared'
import { checkColdOutreachCap, checkGlobalRateLimit, checkGroupAggregateRateLimit } from './enforcement.service.js'
import { sendToAgent, sendToOwner } from '../ws/events.js'
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

/**
 * Reject the send if the sender's owner has paused the agent. Both
 * pause modes ('send' and 'full') block outbound messaging — the
 * modes differ only on the receive-side fan-out, which is handled
 * separately in pushToRecipient / pushToGroup / the WS reconnect
 * drain. Called from both sendDirectMessage and sendGroupMessage
 * right after the sender is fetched, before the rate limit spends
 * a bucket slot on a message that's about to be rejected anyway.
 */
function assertNotPausedByOwner(sender: { paused_by_owner?: string | null }) {
  const mode = sender.paused_by_owner ?? 'none'
  if (mode !== 'none') {
    messagesSendRejected.inc({ reason: 'paused_by_owner' })
    throw new MessageError(
      'AGENT_PAUSED_BY_OWNER',
      'Your account is paused by the owner. Messaging is temporarily disabled.',
      403,
    )
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
  assertNotPausedByOwner(sender)
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

  // 5. Global per-second rate limit (60/sec for regular agents, 200/sec for
  //    system agents — migration 040). sender.is_system is the authoritative
  //    source; the caller cannot lie because it comes from the fetched row.
  const senderIsSystem = sender.is_system === true
  const rateCheck = await checkGlobalRateLimit(senderId, senderIsSystem)
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

  // 6. Cold outreach cap (only for new conversations — 100/day, reply frees
  //    slot). System agents (migration 040) are exempt: chatfather's
  //    onboarding welcome is structurally a cold message to every new agent.
  if (!existingConvId) {
    const capCheck = await checkColdOutreachCap(senderId, senderIsSystem)
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
  //     A backlogged recipient (§3.4.2) raises before anything persists; we
  //     translate into the standard RECIPIENT_BACKLOGGED/429 error shape.
  const messageId = generateId('msg')
  const message = await atomicSendMessage({
    id: messageId,
    conversation_id: conversationId,
    sender_id: senderId,
    client_msg_id: req.client_msg_id,
    type: req.type ?? 'text',
    content: req.content as Record<string, unknown>,
    metadata: req.metadata as Record<string, unknown> | undefined,
  }).catch((err: unknown): never => {
    if (err instanceof RecipientBackloggedError) {
      messagesSendRejected.inc({ reason: 'recipient_backlogged' })
      throw new MessageError(
        'RECIPIENT_BACKLOGGED',
        'Recipient has too many undelivered messages. Try again later.',
        429,
      )
    }
    throw err
  })

  // Map sender_id to sender handle BEFORE any external delivery
  const publicMessage = toPublicMessage(message, sender.handle)

  // 10. ASYNC PUSH — only fire on first write, not on idempotent replay.
  //    Replaying a delivered message would double-deliver to the recipient.
  //    Also suppresses real-time push when the recipient is in 'full' pause:
  //    the message is still durable in message_deliveries and will drain
  //    naturally once the owner unpauses, but no WS / webhook fires now.
  if (!message.is_replay) {
    messagesSent.inc({ outcome: 'ok' })
    const recipientFullyPaused =
      (recipient.paused_by_owner as string | null) === 'full'
    // Mute check: agent-level mute (recipient muted sender) or DM-level mute
    // (recipient muted this conversation) collapses to the same signal from
    // send_message_atomic — either way the recipient's id appears in
    // muted_recipient_ids and we suppress the real-time WS push. Envelope
    // still lives in message_deliveries (RPC writes it unconditionally), so
    // /messages/sync and the unread counter stay accurate; only the wake-up
    // event is withheld. Outbox/webhook fan-out is filtered at the RPC
    // (migration 034) so we don't need to repeat that here.
    const recipientMuted = (message.muted_recipient_ids ?? []).includes(recipient.id)
    if (!recipientFullyPaused && !recipientMuted) {
      pushToRecipient(recipient.id, publicMessage).catch(() => {
        // Push failed — that's fine, message is safe in DB
      })
    }
    // Dashboard owner fan-out — runs independently of the recipient pause
    // state AND of mute, because the owner WANTS to see what their claimed
    // agent is receiving regardless of the agent's own preferences. Only
    // suppressed on replay, same as the agent push.
    pushDirectToOwnerDashboards(
      message as DashboardFanoutMessage,
      senderId,
      sender.handle,
      recipient.id,
      recipient.handle,
    ).catch(() => {
      // Fan-out failed — dashboard reconciles on next router.refresh()
    })
  } else {
    messagesSent.inc({ outcome: 'replay' })
  }

  // Surface the recipient's current backlog depth back to the caller so
  // the route can attach a soft-warning header before the sender hits
  // the 10K hard wall (RecipientBackloggedError). 5K is half the cap —
  // gives senders ~5K-message runway to back off, slow down, or alert
  // the recipient operator. Group sends rely on the per-recipient skip
  // path inside send_message_atomic instead, so this signal is direct-
  // only.
  const recipientUndelivered =
    typeof recipient.undelivered_count === 'number'
      ? recipient.undelivered_count
      : null

  return {
    message: publicMessage,
    isReplay: message.is_replay,
    skippedRecipients: [] as string[],
    recipientHandle: recipient.handle as string,
    recipientUndelivered,
  }
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
  assertNotPausedByOwner(sender)
  if (!role) {
    // Hide existence of the group from non-members.
    messagesSendRejected.inc({ reason: 'group_not_member' })
    throw new MessageError('GROUP_NOT_FOUND', 'Group not found', 404)
  }

  const rateCheck = await checkGlobalRateLimit(senderId, sender.is_system === true)
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

  // Per-group aggregate cap — counts every sender's messages into one bucket
  // keyed on conversation_id. The only layer that bounds coordinated K-sender
  // abuse in a single room; per-agent buckets can't see across accounts. The
  // 20/sec ceiling matches the consumption rate of a busy legit group, not
  // the fleet's raw capacity.
  const groupAggregateCheck = await checkGroupAggregateRateLimit(conversationId)
  if (!groupAggregateCheck.allowed) {
    rateLimitHits.inc({ rule: 'group_aggregate' })
    messagesSendRejected.inc({ reason: 'rate_limited' })
    throw new MessageError(
      'RATE_LIMITED',
      'This group is receiving too many messages per second',
      429,
      groupAggregateCheck.retryAfterMs,
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
  }).catch(async (err: unknown): Promise<never> => {
    // Migration 020 added a deleted_at guard on send_message_atomic. It
    // fires when a concurrent delete committed between findGroupById above
    // and the RPC acquiring its FOR UPDATE lock. Translate to the same
    // 410 shape the pre-check returns so clients see one consistent error
    // regardless of where in the race window the delete landed.
    if (err instanceof Error && /group_deleted/.test(err.message)) {
      const deletedCheck = await resolveDeletedGroupInfoForCaller(
        conversationId,
        senderId,
      )
      messagesSendRejected.inc({ reason: 'group_deleted' })
      throw new MessageError(
        'GROUP_DELETED',
        'Group has been deleted',
        410,
        undefined,
        deletedCheck?.kind === 'gone'
          ? (deletedCheck.info as unknown as Record<string, unknown>)
          : undefined,
      )
    }
    throw err
  })

  const publicMessage = toPublicMessage(message, sender.handle)

  // Backlogged members (§3.4.2) got no envelope from the RPC. The push
  // fan-out must also skip them, or they would receive a WS / webhook
  // event for a message with no durable record for them — breaking the
  // invariant that every received event has a matching delivery row.
  // Resolve handles once so the response can report them back to the
  // sender; empty on replay or when nothing was skipped.
  const skippedIds = message.skipped_recipient_ids ?? []
  const skippedHandleMap =
    skippedIds.length > 0
      ? await getAgentHandlesByIds(skippedIds).catch(() => new Map<string, string>())
      : new Map<string, string>()
  const skippedHandles: string[] = []
  for (const id of skippedIds) {
    const h = skippedHandleMap.get(id)
    if (h) skippedHandles.push(h)
  }

  if (!message.is_replay) {
    messagesSent.inc({ outcome: 'ok' })
    if (skippedIds.length > 0) {
      messagesSendRejected.inc({ reason: 'recipient_backlogged_skipped' })
    }
    // Async fan-out to all active members except the sender. Recipient set
    // is filtered by `joined_seq <= message.seq` so that a member who
    // joined AFTER send_message_atomic committed (but before this async
    // push fires) does not receive a ghost `message.new` event for a
    // message their history cutoff would hide. The DB envelopes already
    // exclude them — this query mirrors the same rule for the ephemeral
    // push so the two stay consistent.
    pushToGroup(
      conversationId,
      senderId,
      message.seq,
      publicMessage,
      skippedIds,
      message.muted_recipient_ids ?? [],
    ).catch(() => {
      // Push failed — DB state is durable, sync/WS reconnect recovers it
    })
    // Dashboard owner fan-out runs in parallel with the agent push.
    // It does its own getGroupPushRecipients lookup so the existing
    // pushToGroup signature stays untouched.
    pushGroupToOwnerDashboards(
      message as DashboardFanoutMessage,
      conversationId,
      senderId,
      sender.handle,
      message.seq,
      skippedIds,
    ).catch(() => {
      // Fan-out failed — dashboard reconciles on next router.refresh()
    })
  } else {
    messagesSent.inc({ outcome: 'replay' })
  }

  return {
    message: publicMessage,
    isReplay: message.is_replay,
    skippedRecipients: skippedHandles,
    // Group sends don't surface a per-recipient backlog warning — the
    // existing skipped_recipients list is the wire-level signal for the
    // 10K hard wall, and aggregating across N recipients into one
    // header would force a callsite to choose which one to name.
    recipientHandle: null as string | null,
    recipientUndelivered: null as number | null,
  }
}

// ─── Dashboard owner fan-out ──────────────────────────────────────────────
// Runs alongside the existing agent push (sendToAgent) to feed every
// dashboard tab a claimed owner has open. See WIRE-CONTRACT §Events/
// message.new and §Server-side fan-out rules.
//
// Payload shape mirrors DashboardMessage at
// apps/dashboard/src/lib/types.ts:57-72. sender_id is NEVER included.
// For a freshly-stored message the delivery envelope fields collapse to
// their "no envelope yet" defaults — the dashboard calls router.refresh()
// on message.new anyway so the reconciled state arrives via the RPC.

interface DashboardFanoutMessage {
  id: string
  conversation_id: string
  sender_id: string
  seq: number
  type: string
  content: Record<string, unknown>
  metadata: Record<string, unknown>
  created_at: string
}

function buildDashboardPayload(msg: DashboardFanoutMessage, isOwn: boolean) {
  return {
    id: msg.id,
    conversation_id: msg.conversation_id,
    is_own: isOwn,
    seq: msg.seq,
    type: msg.type,
    content: msg.content,
    metadata: msg.metadata,
    created_at: msg.created_at,
    // Freshly-stored: no delivery envelope state to report yet. The
    // dashboard re-fetches through get_agent_messages_for_owner on
    // router.refresh() to pick up delivered/read transitions.
    delivery_id: null,
    status: 'stored',
    delivered_at: null,
    read_at: null,
  }
}

function buildDashboardEvent(
  agentHandle: string,
  conversationId: string,
  msg: DashboardFanoutMessage,
  isOwn: boolean,
) {
  return {
    type: 'message.new',
    agent_handle: agentHandle,
    conversation_id: conversationId,
    payload: buildDashboardPayload(msg, isOwn),
  }
}

/**
 * Fan out a direct-message event to both sides' owner dashboards.
 * If both sides resolve to the same owner (a rare self-to-self claim
 * topology, but possible if one owner claims two agents pinging each
 * other) we emit BOTH events — sender view first, then recipient view
 * — so the dashboard sees both halves of the conversation.
 */
async function pushDirectToOwnerDashboards(
  msg: DashboardFanoutMessage,
  senderId: string,
  senderHandle: string,
  recipientId: string,
  recipientHandle: string,
) {
  const [senderOwner, recipientOwner] = await Promise.all([
    findOwnerIdForAgent(senderId).catch(() => null),
    findOwnerIdForAgent(recipientId).catch(() => null),
  ])

  // Sender view first — matches WIRE-CONTRACT §3 ordering when the same
  // owner claims both sides.
  if (senderOwner) {
    sendToOwner(
      senderOwner,
      buildDashboardEvent(senderHandle, msg.conversation_id, msg, true),
    )
  }
  if (recipientOwner) {
    sendToOwner(
      recipientOwner,
      buildDashboardEvent(recipientHandle, msg.conversation_id, msg, false),
    )
  }
}

/**
 * Fan out a group-message event to every recipient's owner + the sender's
 * owner. Dedupe is per-ownerId within the recipient loop so an owner who
 * claims multiple members of the same group doesn't see the same message
 * twice. The sender branch always runs, after the recipient loop, and is
 * deliberately NOT deduped against recipients because the is_own flag
 * differs between the two views (WIRE-CONTRACT §Server-side fan-out #2).
 *
 * The recipient set is fetched via a fresh getGroupPushRecipients call so
 * the existing pushToGroup signature stays untouched. The query is cheap
 * relative to the N owner lookups that follow, and keeps this helper
 * independent of the agent push path.
 */
async function pushGroupToOwnerDashboards(
  msg: DashboardFanoutMessage,
  conversationId: string,
  senderId: string,
  senderHandle: string,
  messageSeq: number,
  skippedRecipientIds: readonly string[] = [],
) {
  const rawRecipientIds = await getGroupPushRecipients(
    conversationId,
    messageSeq,
    senderId,
  )
  // §3.4.2: a backlogged member has no delivery envelope, so they must
  // not receive the dashboard fan-out either. Skipped set is tiny — a
  // Set lookup is cheaper than an IN-query in the DB.
  const skipped = new Set(skippedRecipientIds)
  const recipientIds = rawRecipientIds.filter((id) => !skipped.has(id))
  if (recipientIds.length === 0) {
    // Still fan out the sender view even if there are no live recipients
    // (everyone else is fully-paused or has left mid-send).
    const senderOwner = await findOwnerIdForAgent(senderId).catch(() => null)
    if (senderOwner) {
      sendToOwner(
        senderOwner,
        buildDashboardEvent(senderHandle, conversationId, msg, true),
      )
    }
    return
  }

  // Resolve recipient owners + handles in parallel so large groups pay
  // one round-trip per dependency instead of serializing them.
  const [owners, handleMap] = await Promise.all([
    Promise.all(recipientIds.map((id) => findOwnerIdForAgent(id).catch(() => null))),
    getAgentHandlesByIds(recipientIds).catch(() => new Map<string, string>()),
  ])

  const seen = new Set<string>()
  for (let i = 0; i < recipientIds.length; i++) {
    const ownerId = owners[i]
    if (!ownerId) continue
    if (seen.has(ownerId)) continue
    seen.add(ownerId)
    const recipientId = recipientIds[i]!
    const handle = handleMap.get(recipientId)
    if (!handle) continue // agent row missing (soft-deleted mid-send)
    sendToOwner(
      ownerId,
      buildDashboardEvent(handle, conversationId, msg, false),
    )
  }

  // Sender branch — always runs as a separate event.
  const senderOwner = await findOwnerIdForAgent(senderId).catch(() => null)
  if (senderOwner) {
    sendToOwner(
      senderOwner,
      buildDashboardEvent(senderHandle, conversationId, msg, true),
    )
  }
}

// Exported for unit testing. Call site is local; nothing outside this
// module should depend on the signature.
export async function pushToGroup(
  conversationId: string,
  senderId: string,
  messageSeq: number,
  message: Record<string, unknown>,
  skippedRecipientIds: readonly string[] = [],
  mutedRecipientIds: readonly string[] = [],
) {
  // Single round-trip: active, non-departed, non-late-joiner, non-sender.
  // Returns agent ids directly so we avoid the handle→agent N+1 roundtrip
  // the previous implementation did through findAgentByHandle.
  const rawRecipientIds = await getGroupPushRecipients(
    conversationId,
    messageSeq,
    senderId,
  )
  // §3.4.2: backlogged members have no envelope — exclude them from the
  // WS + webhook fan-out so a received event always matches a stored row.
  const skipped = new Set(skippedRecipientIds)
  // Muted members DO have an envelope (RPC still writes message_deliveries
  // for them — so /sync and the unread counter stay honest), but we don't
  // wake them up on the real-time channel. Membership comes from
  // send_message_atomic, which merged agent-kind and conversation-kind
  // mutes into one set keyed by recipient id.
  const muted = new Set(mutedRecipientIds)
  const recipientIds = rawRecipientIds.filter((id) => !skipped.has(id) && !muted.has(id))
  // Drop any recipients whose owner has full-paused them. The DB envelopes
  // in message_deliveries still exist, so the message drains normally once
  // the pause lifts — we only skip the real-time fan-out for now. One
  // extra IN-query per fan-out regardless of group size.
  const fullyPaused = await listFullyPausedAgentIds(recipientIds)
  for (const agentId of recipientIds) {
    if (fullyPaused.has(agentId)) continue
    sendToAgent(agentId, {
      type: 'message.new',
      payload: message,
    })
    // Webhook fan-out for message.new no longer happens here. Moved to the
    // message_outbox table (migration 031): send_message_atomic writes an
    // outbox row per recipient inside the same transaction as the message,
    // and outbox-worker.ts drains those rows into webhook_deliveries. This
    // closed the old gap where a crash between RPC commit and fireWebhooks
    // dropped the event silently (durable message, lost webhook).
  }
}

/** Strip internal sender_id (and internal is_replay flag), replace sender_id
 *  with the public sender handle. */
function toPublicMessage(msg: Record<string, unknown>, senderHandle: string) {
  const {
    sender_id: _sender,
    is_replay: _replay,
    skipped_recipient_ids: _skipped,
    muted_recipient_ids: _muted,
    ...rest
  } = msg
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
  // WS is the only real-time path fired here. Webhook fan-out moved to the
  // durable message_outbox table (migration 031) — send_message_atomic
  // writes an outbox row inside the same transaction as the message and
  // the outbox worker drains it into webhook_deliveries. Benefit: no more
  // post-commit gap where a crash loses webhook events the message survived.
  // Pub/sub fans this WS event out to all servers; the server holding the
  // WebSocket delivers + marks "delivered". /sync is the final safety net
  // for anything the WS push misses.
  sendToAgent(recipientId, {
    type: 'message.new',
    payload: message,
  })
}

export async function getMessages(
  agentId: string,
  conversationId: string,
  limit = 50,
  beforeSeq?: number,
  afterSeq?: number,
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
      afterSeq,
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

  const senderId = message.sender_id as string
  // Resolve reader + sender in parallel. Sender's paused_by_owner gates
  // the live read-receipt fan-out: a fully-paused sender should not see
  // any push events at all (matches the pause spec — push fan-out and
  // reconnect drain are suppressed). The read row is still durable in
  // message_deliveries so the sender will see it when they next read
  // the message via /v1/messages/:id.
  const [reader, senderAgent] = await Promise.all([
    findAgentById(agentId),
    findAgentById(senderId),
  ])
  const readerHandle = reader?.handle ?? 'unknown'
  const readPayload = {
    message_id: messageId,
    read_by: readerHandle,
    read_at: delivery.read_at,
  }

  const senderFullyPaused =
    (senderAgent?.paused_by_owner as string | null) === 'full'
  if (!senderFullyPaused) {
    sendToAgent(senderId, { type: 'message.read', payload: readPayload })
    fireWebhooks(senderId, 'message.read', readPayload)
  }

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
  // hasParticipantHistory (not isParticipant) so former group members who
  // were there when the message was sent can still clean it from their
  // own hide list. isParticipant filters left_at IS NULL, which would
  // lock out anyone who left or was kicked after receiving the message.
  const hasHistory = await hasParticipantHistory(conversationId, agentId)
  if (!hasHistory) {
    throw new MessageError(
      'FORBIDDEN',
      'You are not a participant in this conversation',
      403,
    )
  }

  await hideMessageForAgent(messageId, agentId)
}
