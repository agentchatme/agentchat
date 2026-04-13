import { describe, it, expect, vi, beforeEach } from 'vitest'

// Covers the joined_seq filter on the ephemeral group push path. The DB
// envelopes for a group message only land in members whose row existed
// at send_message_atomic time (under the conversation row lock). The
// ephemeral WS + webhook fan-out used to race that rule by re-reading
// the current membership — a member who joined BETWEEN commit and push
// would get a `message.new` event for a message their joined_seq cutoff
// hides. `pushToGroup` now filters through `getGroupPushRecipients`,
// which applies the same `joined_seq <= message.seq` rule at the DB.

// These mocks must be declared before importing the module under test so
// vitest hoists them ahead of the target's module evaluation.
const getGroupPushRecipientsMock = vi.fn<
  (conversationId: string, maxSeq: number, excludeAgentId: string) => Promise<string[]>
>()

vi.mock('@agentchat/db', () => ({
  getGroupPushRecipients: getGroupPushRecipientsMock,
  // The service module imports many other symbols from @agentchat/db at
  // top level. Stub them as no-ops so the import graph resolves — we
  // only exercise pushToGroup here, which touches just one DB call.
  findAgentByHandle: vi.fn(),
  findAgentById: vi.fn(),
  findDirectConversation: vi.fn(),
  atomicSendMessage: vi.fn(),
  getConversationMessages: vi.fn(),
  getConversationHide: vi.fn(),
  getMessageById: vi.fn(),
  updateDeliveryStatus: vi.fn(),
  getUndeliveredMessages: vi.fn(),
  ackDeliveries: vi.fn(),
  hideMessageForAgent: vi.fn(),
  isBlockedEither: vi.fn(),
  isContact: vi.fn(),
  findOrCreateDirectConversation: vi.fn(),
  isParticipant: vi.fn(),
  getConversation: vi.fn(),
  markConversationEstablished: vi.fn(),
  addContact: vi.fn(),
  findGroupById: vi.fn(),
  getGroupParticipantRole: vi.fn(),
  getGroupParticipantJoinedSeq: vi.fn(),
  getAttachmentById: vi.fn(),
}))

const sendToAgentMock = vi.fn()
vi.mock('../src/ws/events.js', () => ({
  sendToAgent: sendToAgentMock,
}))

const fireWebhooksMock = vi.fn()
vi.mock('../src/services/webhook.service.js', () => ({
  fireWebhooks: fireWebhooksMock,
}))

// enforcement.service is imported by message.service at the top — stub
// the handful of functions it exports so the module loads.
vi.mock('../src/services/enforcement.service.js', () => ({
  checkColdOutreachCap: vi.fn(),
  checkGlobalRateLimit: vi.fn(),
}))

// metrics exposes counters with .inc() — simple shims are enough.
vi.mock('../src/lib/metrics.js', () => ({
  messagesSent: { inc: vi.fn() },
  messagesSendRejected: { inc: vi.fn() },
  rateLimitHits: { inc: vi.fn() },
}))

const { pushToGroup } = await import('../src/services/message.service.js')

describe('pushToGroup', () => {
  beforeEach(() => {
    getGroupPushRecipientsMock.mockReset()
    sendToAgentMock.mockReset()
    fireWebhooksMock.mockReset()
  })

  it('forwards only the agent ids returned by getGroupPushRecipients', async () => {
    getGroupPushRecipientsMock.mockResolvedValue(['agt_alice', 'agt_bob'])
    await pushToGroup('conv_xyz', 'agt_sender', 42, { id: 'msg_1', seq: 42 })

    expect(getGroupPushRecipientsMock).toHaveBeenCalledWith('conv_xyz', 42, 'agt_sender')
    expect(sendToAgentMock).toHaveBeenCalledTimes(2)
    expect(sendToAgentMock).toHaveBeenNthCalledWith(1, 'agt_alice', {
      type: 'message.new',
      payload: { id: 'msg_1', seq: 42 },
    })
    expect(sendToAgentMock).toHaveBeenNthCalledWith(2, 'agt_bob', {
      type: 'message.new',
      payload: { id: 'msg_1', seq: 42 },
    })
    expect(fireWebhooksMock).toHaveBeenCalledTimes(2)
    expect(fireWebhooksMock).toHaveBeenNthCalledWith(
      1,
      'agt_alice',
      'message.new',
      { id: 'msg_1', seq: 42 },
    )
    expect(fireWebhooksMock).toHaveBeenNthCalledWith(
      2,
      'agt_bob',
      'message.new',
      { id: 'msg_1', seq: 42 },
    )
  })

  it('does NOT push to late joiners (simulated by DB filter returning empty)', async () => {
    // Real scenario: message_seq=10, late joiner's joined_seq=11. The DB
    // query returns no one because joined_seq > maxSeq. This test pins
    // the behavior: if the DB says "no eligible recipients", no WS/webhook
    // event fires.
    getGroupPushRecipientsMock.mockResolvedValue([])
    await pushToGroup('conv_xyz', 'agt_sender', 10, { id: 'msg_1', seq: 10 })

    expect(getGroupPushRecipientsMock).toHaveBeenCalledWith('conv_xyz', 10, 'agt_sender')
    expect(sendToAgentMock).not.toHaveBeenCalled()
    expect(fireWebhooksMock).not.toHaveBeenCalled()
  })

  it('passes messageSeq through to the DB filter — not a stale value', async () => {
    getGroupPushRecipientsMock.mockResolvedValue([])
    await pushToGroup('conv_abc', 'agt_s', 99, { id: 'm', seq: 99 })
    await pushToGroup('conv_abc', 'agt_s', 100, { id: 'm2', seq: 100 })

    expect(getGroupPushRecipientsMock).toHaveBeenNthCalledWith(1, 'conv_abc', 99, 'agt_s')
    expect(getGroupPushRecipientsMock).toHaveBeenNthCalledWith(2, 'conv_abc', 100, 'agt_s')
  })
})
