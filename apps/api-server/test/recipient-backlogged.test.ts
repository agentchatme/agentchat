import { describe, it, expect, vi, beforeEach } from 'vitest'

// Covers the direct-send path of §3.4.2. When the recipient is at the
// per-recipient undelivered-envelope cap, send_message_atomic raises
// `recipient_backlogged`, the db wrapper translates to
// RecipientBackloggedError, and the service layer must map that onto a
// MessageError with code=RECIPIENT_BACKLOGGED and status=429 so the
// sender sees a standard retryable rate-limit shape.

class RecipientBackloggedError extends Error {
  readonly recipientId: string
  constructor(recipientId: string) {
    super(`Recipient ${recipientId} is backlogged`)
    this.name = 'RecipientBackloggedError'
    this.recipientId = recipientId
  }
}

const atomicSendMessageMock = vi.fn()
const findAgentByHandleMock = vi.fn()
const findAgentByIdMock = vi.fn()
const isBlockedEitherMock = vi.fn()
const findDirectConversationMock = vi.fn()
const findOrCreateDirectConversationMock = vi.fn()

vi.mock('@agentchat/db', () => ({
  findAgentByHandle: findAgentByHandleMock,
  findAgentById: findAgentByIdMock,
  findDirectConversation: findDirectConversationMock,
  atomicSendMessage: atomicSendMessageMock,
  RecipientBackloggedError,
  getConversationMessages: vi.fn(),
  getConversationHide: vi.fn(),
  getMessageById: vi.fn(),
  updateDeliveryStatus: vi.fn(),
  getUndeliveredMessages: vi.fn(),
  ackDeliveries: vi.fn(),
  hideMessageForAgent: vi.fn(),
  isBlockedEither: isBlockedEitherMock,
  isContact: vi.fn(),
  findOrCreateDirectConversation: findOrCreateDirectConversationMock,
  isParticipant: vi.fn(),
  hasParticipantHistory: vi.fn(),
  getConversation: vi.fn().mockResolvedValue(null),
  markConversationEstablished: vi.fn(),
  addContact: vi.fn(),
  findGroupById: vi.fn(),
  getGroupParticipantRole: vi.fn(),
  getGroupParticipantJoinedSeq: vi.fn(),
  getGroupPushRecipients: vi.fn().mockResolvedValue([]),
  getAttachmentById: vi.fn(),
  listFullyPausedAgentIds: vi.fn().mockResolvedValue(new Set<string>()),
  findOwnerIdForAgent: vi.fn().mockResolvedValue(null),
  getAgentHandlesByIds: vi.fn().mockResolvedValue(new Map<string, string>()),
}))

vi.mock('../src/ws/events.js', () => ({
  sendToAgent: vi.fn(),
  sendToOwner: vi.fn(),
}))

vi.mock('../src/services/webhook.service.js', () => ({
  fireWebhooks: vi.fn(),
}))

vi.mock('../src/services/enforcement.service.js', () => ({
  checkColdOutreachCap: vi.fn().mockResolvedValue({ allowed: true }),
  checkGlobalRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}))

vi.mock('../src/lib/metrics.js', () => ({
  messagesSent: { inc: vi.fn() },
  messagesSendRejected: { inc: vi.fn() },
  rateLimitHits: { inc: vi.fn() },
}))

const { sendMessage, MessageError } = await import(
  '../src/services/message.service.js'
)

describe('sendMessage (direct) — §3.4.2 recipient backlog', () => {
  beforeEach(() => {
    atomicSendMessageMock.mockReset()
    findAgentByHandleMock.mockReset()
    findAgentByIdMock.mockReset()
    isBlockedEitherMock.mockReset()
    findDirectConversationMock.mockReset()
    findOrCreateDirectConversationMock.mockReset()

    findAgentByHandleMock.mockResolvedValue({
      id: 'agt_recipient',
      handle: 'bob',
      settings: { inbox_mode: 'open' },
      paused_by_owner: null,
    })
    findAgentByIdMock.mockResolvedValue({
      id: 'agt_sender',
      handle: 'alice',
      status: 'active',
      paused_by_owner: null,
    })
    isBlockedEitherMock.mockResolvedValue(false)
    findDirectConversationMock.mockResolvedValue('conv_existing')
    findOrCreateDirectConversationMock.mockResolvedValue({
      conversationId: 'conv_existing',
    })
  })

  it('translates RecipientBackloggedError into 429 RECIPIENT_BACKLOGGED', async () => {
    atomicSendMessageMock.mockRejectedValue(
      new RecipientBackloggedError('agt_recipient'),
    )

    await expect(
      sendMessage('agt_sender', {
        to: '@bob',
        client_msg_id: 'cmid_1',
        type: 'text',
        content: { text: 'hello' },
      }),
    ).rejects.toMatchObject({
      name: 'MessageError',
      code: 'RECIPIENT_BACKLOGGED',
      status: 429,
    })
  })

  it('does not persist when the recipient is backlogged', async () => {
    atomicSendMessageMock.mockRejectedValue(
      new RecipientBackloggedError('agt_recipient'),
    )

    await sendMessage('agt_sender', {
      to: '@bob',
      client_msg_id: 'cmid_2',
      type: 'text',
      content: { text: 'hello' },
    }).catch(() => undefined)

    // Service layer treats the raise as terminal — no retry, no further
    // DB writes, no WS push. The RPC already rolled back its transaction
    // so nothing is durable. The only side effect is the rejection metric.
    expect(atomicSendMessageMock).toHaveBeenCalledTimes(1)
  })

  it('happy path still returns empty skippedRecipients for direct', async () => {
    atomicSendMessageMock.mockResolvedValue({
      id: 'msg_1',
      conversation_id: 'conv_existing',
      sender_id: 'agt_sender',
      client_msg_id: 'cmid_ok',
      seq: 1,
      type: 'text',
      content: { text: 'hi' },
      metadata: {},
      created_at: new Date().toISOString(),
      is_replay: false,
      skipped_recipient_ids: [],
    })

    const result = await sendMessage('agt_sender', {
      to: '@bob',
      client_msg_id: 'cmid_ok',
      type: 'text',
      content: { text: 'hi' },
    })

    expect(result.skippedRecipients).toEqual([])
    expect(result.isReplay).toBe(false)
    expect(result.message).toMatchObject({ id: 'msg_1', sender: 'alice' })
  })
})

describe('MessageError shape for RECIPIENT_BACKLOGGED', () => {
  it('is an instance of MessageError so the route maps it correctly', () => {
    const e = new MessageError(
      'RECIPIENT_BACKLOGGED',
      'Recipient has too many undelivered messages.',
      429,
    )
    expect(e).toBeInstanceOf(MessageError)
    expect(e.status).toBe(429)
  })
})
