import { describe, it, expect, beforeEach, vi } from 'vitest'

// Covers the message_outbox drain loop (migration 031). The outbox is the
// transactional bridge between send_message_atomic and webhook_deliveries:
// if this worker drops rows, webhook receivers silently miss events even
// though messages committed. The tests here pin the contract the worker
// owes every outbox row:
//   - delivered: at-least-once handoff to webhook_deliveries with
//     deterministic ids (idempotent under reclaim-race)
//   - no_webhooks: still deletes the outbox row (work is resolved)
//   - orphaned: missing message deletes the row too (don't loop on ghosts)
//   - failed: lookup errors release the whole batch via
//     recordOutboxFailure; per-row failures release only that row

const claimMessageOutboxMock = vi.fn()
const processOutboxRowMock = vi.fn()
const recordOutboxFailureMock = vi.fn()
const getMessagesByIdsMock = vi.fn()
const getWebhooksForAgentsAndEventMock = vi.fn()
const findAgentByIdMock = vi.fn()

vi.mock('@agentchat/db', () => ({
  claimMessageOutbox: claimMessageOutboxMock,
  processOutboxRow: processOutboxRowMock,
  recordOutboxFailure: recordOutboxFailureMock,
  getMessagesByIds: getMessagesByIdsMock,
  getWebhooksForAgentsAndEvent: getWebhooksForAgentsAndEventMock,
  findAgentById: findAgentByIdMock,
}))

vi.mock('../src/lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

// Metrics are side-effect-only from the worker's POV. Stub with no-ops so
// the counter/histogram registry doesn't leak between tests.
vi.mock('../src/lib/metrics.js', () => ({
  outboxProcessed: { inc: vi.fn() },
  outboxTickSeconds: { observe: vi.fn() },
}))

const { _tickForTests, _deriveDeliveryIdForTests } = await import(
  '../src/services/outbox-worker.js'
)

function resetAll() {
  claimMessageOutboxMock.mockReset()
  processOutboxRowMock.mockReset()
  recordOutboxFailureMock.mockReset()
  getMessagesByIdsMock.mockReset()
  getWebhooksForAgentsAndEventMock.mockReset()
  findAgentByIdMock.mockReset()
  // Sensible defaults — each test overrides what it cares about.
  claimMessageOutboxMock.mockResolvedValue([])
  processOutboxRowMock.mockResolvedValue(undefined)
  recordOutboxFailureMock.mockResolvedValue(undefined)
  getMessagesByIdsMock.mockResolvedValue(new Map())
  getWebhooksForAgentsAndEventMock.mockResolvedValue(new Map())
  findAgentByIdMock.mockResolvedValue(null)
}

describe('outbox-worker: happy path', () => {
  beforeEach(resetAll)

  it('claims + resolves + hands off webhook_deliveries rows, then deletes outbox', async () => {
    // Single recipient, single webhook — the simplest fan-out. Verifies
    // payload composition matches toPublicMessage (sender_id dropped, sender
    // handle injected) and that processOutboxRow receives the deterministic
    // delivery id derived from (outbox_id, webhook_id).
    claimMessageOutboxMock.mockResolvedValue([
      {
        id: 'obx_1',
        message_id: 'msg_1',
        conversation_id: 'conv_1',
        target_agent_id: 'agt_bob',
        event: 'message.new',
        attempts: 1,
      },
    ])
    getMessagesByIdsMock.mockResolvedValue(
      new Map([
        [
          'msg_1',
          {
            id: 'msg_1',
            conversation_id: 'conv_1',
            sender_id: 'agt_alice',
            client_msg_id: 'cmid_1',
            seq: 42,
            type: 'text',
            content: { text: 'hi' },
            metadata: {},
            created_at: '2026-04-18T00:00:00.000Z',
          },
        ],
      ]),
    )
    getWebhooksForAgentsAndEventMock.mockResolvedValue(
      new Map([
        [
          'agt_bob',
          [
            {
              id: 'whk_1',
              url: 'https://bob.example/hook',
              secret: 's3cr3t',
              events: ['message.new'],
            },
          ],
        ],
      ]),
    )
    findAgentByIdMock.mockResolvedValue({ id: 'agt_alice', handle: 'alice' })

    await _tickForTests()

    expect(processOutboxRowMock).toHaveBeenCalledTimes(1)
    const [outboxId, webhookRows] = processOutboxRowMock.mock.calls[0]!
    expect(outboxId).toBe('obx_1')
    expect(webhookRows).toHaveLength(1)
    const row = webhookRows[0]
    expect(row.id).toBe(_deriveDeliveryIdForTests('obx_1', 'whk_1'))
    expect(row.webhook_id).toBe('whk_1')
    expect(row.agent_id).toBe('agt_bob')
    expect(row.url).toBe('https://bob.example/hook')
    expect(row.secret).toBe('s3cr3t')
    expect(row.event).toBe('message.new')
    expect(row.payload.event).toBe('message.new')
    expect(row.payload.data).toMatchObject({
      id: 'msg_1',
      seq: 42,
      sender: 'alice',
      type: 'text',
    })
    // sender_id must be stripped from the public payload — it's an
    // internal column and webhook consumers get the handle instead.
    expect(row.payload.data).not.toHaveProperty('sender_id')
    expect(recordOutboxFailureMock).not.toHaveBeenCalled()
  })

  it('batches a group fan-out: one message, many recipients → one lookup each', async () => {
    // A 3-recipient group message produces 3 outbox rows sharing the same
    // message_id. The worker should issue ONE messages query and ONE
    // webhooks query for the whole batch, not 3× of each.
    claimMessageOutboxMock.mockResolvedValue([
      {
        id: 'obx_a',
        message_id: 'msg_g',
        conversation_id: 'conv_g',
        target_agent_id: 'agt_bob',
        event: 'message.new',
        attempts: 1,
      },
      {
        id: 'obx_b',
        message_id: 'msg_g',
        conversation_id: 'conv_g',
        target_agent_id: 'agt_carol',
        event: 'message.new',
        attempts: 1,
      },
      {
        id: 'obx_c',
        message_id: 'msg_g',
        conversation_id: 'conv_g',
        target_agent_id: 'agt_dave',
        event: 'message.new',
        attempts: 1,
      },
    ])
    getMessagesByIdsMock.mockResolvedValue(
      new Map([
        [
          'msg_g',
          { id: 'msg_g', seq: 7, sender_id: 'agt_alice', type: 'text', content: { text: 'hello everyone' } },
        ],
      ]),
    )
    getWebhooksForAgentsAndEventMock.mockResolvedValue(
      new Map([
        ['agt_bob', [{ id: 'whk_b', url: 'u_b', secret: 's', events: ['message.new'] }]],
        ['agt_carol', [{ id: 'whk_c', url: 'u_c', secret: 's', events: ['message.new'] }]],
        // agt_dave has no webhook — processOutboxRow still called with []
      ]),
    )
    findAgentByIdMock.mockResolvedValue({ id: 'agt_alice', handle: 'alice' })

    await _tickForTests()

    expect(getMessagesByIdsMock).toHaveBeenCalledTimes(1)
    expect(getMessagesByIdsMock).toHaveBeenCalledWith(['msg_g'])
    expect(getWebhooksForAgentsAndEventMock).toHaveBeenCalledTimes(1)
    const [agentIds, event] = getWebhooksForAgentsAndEventMock.mock.calls[0]!
    expect([...agentIds].sort()).toEqual(['agt_bob', 'agt_carol', 'agt_dave'])
    expect(event).toBe('message.new')

    expect(processOutboxRowMock).toHaveBeenCalledTimes(3)
    // Extract per-outbox calls in a stable shape for assertion.
    const calls = Object.fromEntries(
      processOutboxRowMock.mock.calls.map(([id, rows]) => [id, rows]),
    )
    expect(calls['obx_a']).toHaveLength(1)
    expect(calls['obx_b']).toHaveLength(1)
    // dave has no webhook → empty array, outbox row still deletes.
    expect(calls['obx_c']).toEqual([])
  })
})

describe('outbox-worker: degenerate rows', () => {
  beforeEach(resetAll)

  it('no webhooks for target → processOutboxRow called with [] and row deletes', async () => {
    claimMessageOutboxMock.mockResolvedValue([
      {
        id: 'obx_nw',
        message_id: 'msg_nw',
        conversation_id: 'conv_nw',
        target_agent_id: 'agt_mute',
        event: 'message.new',
        attempts: 1,
      },
    ])
    getMessagesByIdsMock.mockResolvedValue(
      new Map([['msg_nw', { id: 'msg_nw', sender_id: 'agt_alice', seq: 1 }]]),
    )
    getWebhooksForAgentsAndEventMock.mockResolvedValue(new Map())
    findAgentByIdMock.mockResolvedValue({ id: 'agt_alice', handle: 'alice' })

    await _tickForTests()

    expect(processOutboxRowMock).toHaveBeenCalledTimes(1)
    expect(processOutboxRowMock).toHaveBeenCalledWith('obx_nw', [])
    expect(recordOutboxFailureMock).not.toHaveBeenCalled()
  })

  it('missing message (partition aged out or hard-deleted) → row still deletes', async () => {
    // If we didn't process the orphan, it would loop forever — attempts
    // climbing, queue depth growing, with no chance of recovery. The
    // worker logs + passes [] so the outbox row resolves cleanly.
    claimMessageOutboxMock.mockResolvedValue([
      {
        id: 'obx_orphan',
        message_id: 'msg_gone',
        conversation_id: 'conv_x',
        target_agent_id: 'agt_bob',
        event: 'message.new',
        attempts: 1,
      },
    ])
    getMessagesByIdsMock.mockResolvedValue(new Map())
    getWebhooksForAgentsAndEventMock.mockResolvedValue(new Map())

    await _tickForTests()

    expect(processOutboxRowMock).toHaveBeenCalledTimes(1)
    expect(processOutboxRowMock).toHaveBeenCalledWith('obx_orphan', [])
    expect(recordOutboxFailureMock).not.toHaveBeenCalled()
  })

  it('empty claim → no downstream calls', async () => {
    claimMessageOutboxMock.mockResolvedValue([])
    await _tickForTests()
    expect(getMessagesByIdsMock).not.toHaveBeenCalled()
    expect(getWebhooksForAgentsAndEventMock).not.toHaveBeenCalled()
    expect(processOutboxRowMock).not.toHaveBeenCalled()
    expect(recordOutboxFailureMock).not.toHaveBeenCalled()
  })
})

describe('outbox-worker: failure paths', () => {
  beforeEach(resetAll)

  it('lookup error releases every claim via recordOutboxFailure', async () => {
    // A transient DB blip at the batch-level SELECTs must not strand the
    // claim — every row needs to come unlocked so the next tick can try
    // again. Without this, a blip during a 200-row batch would leave all
    // 200 in claimed state for 60s before the stale-claim reclaim kicks in.
    claimMessageOutboxMock.mockResolvedValue([
      { id: 'obx_1', message_id: 'm', conversation_id: 'c', target_agent_id: 'a1', event: 'message.new', attempts: 1 },
      { id: 'obx_2', message_id: 'm', conversation_id: 'c', target_agent_id: 'a2', event: 'message.new', attempts: 1 },
    ])
    getMessagesByIdsMock.mockRejectedValue(new Error('conn reset'))

    await _tickForTests()

    expect(processOutboxRowMock).not.toHaveBeenCalled()
    expect(recordOutboxFailureMock).toHaveBeenCalledTimes(2)
    const ids = recordOutboxFailureMock.mock.calls.map((c) => c[0]).sort()
    expect(ids).toEqual(['obx_1', 'obx_2'])
    // Error text is prefixed with 'lookup:' so log readers can tell batch
    // failures apart from per-row process failures at a glance.
    for (const call of recordOutboxFailureMock.mock.calls) {
      expect(call[1]).toMatch(/^lookup:/)
    }
  })

  it('per-row processOutboxRow failure releases only that row', async () => {
    claimMessageOutboxMock.mockResolvedValue([
      { id: 'obx_ok', message_id: 'm', conversation_id: 'c', target_agent_id: 'a1', event: 'message.new', attempts: 1 },
      { id: 'obx_bad', message_id: 'm', conversation_id: 'c', target_agent_id: 'a2', event: 'message.new', attempts: 1 },
    ])
    getMessagesByIdsMock.mockResolvedValue(
      new Map([['m', { id: 'm', sender_id: 's', seq: 1 }]]),
    )
    getWebhooksForAgentsAndEventMock.mockResolvedValue(
      new Map([
        ['a1', [{ id: 'w1', url: 'u1', secret: 's', events: ['message.new'] }]],
        ['a2', [{ id: 'w2', url: 'u2', secret: 's', events: ['message.new'] }]],
      ]),
    )
    findAgentByIdMock.mockResolvedValue({ id: 's', handle: 'sally' })

    processOutboxRowMock.mockImplementation(async (outboxId: string) => {
      if (outboxId === 'obx_bad') throw new Error('deadlock detected')
    })

    await _tickForTests()

    expect(recordOutboxFailureMock).toHaveBeenCalledTimes(1)
    expect(recordOutboxFailureMock).toHaveBeenCalledWith(
      'obx_bad',
      expect.stringMatching(/deadlock/),
    )
  })

  it('sender handle lookup failure degrades to "unknown" and still delivers', async () => {
    // If findAgentById throws for some reason (network blip, agent hard-
    // deleted between message write and outbox drain), the worker must
    // not abandon the row — webhook receivers tolerate a fallback handle.
    claimMessageOutboxMock.mockResolvedValue([
      {
        id: 'obx_unk',
        message_id: 'msg_u',
        conversation_id: 'c',
        target_agent_id: 'agt_bob',
        event: 'message.new',
        attempts: 1,
      },
    ])
    getMessagesByIdsMock.mockResolvedValue(
      new Map([['msg_u', { id: 'msg_u', sender_id: 'agt_ghost', seq: 1 }]]),
    )
    getWebhooksForAgentsAndEventMock.mockResolvedValue(
      new Map([
        ['agt_bob', [{ id: 'whk_b', url: 'u', secret: 's', events: ['message.new'] }]],
      ]),
    )
    findAgentByIdMock.mockRejectedValue(new Error('network'))

    await _tickForTests()

    expect(processOutboxRowMock).toHaveBeenCalledTimes(1)
    const [, webhookRows] = processOutboxRowMock.mock.calls[0]!
    expect(webhookRows[0].payload.data.sender).toBe('unknown')
  })
})

describe('outbox-worker: deterministic delivery id', () => {
  it('same (outbox_id, webhook_id) → same derived id across calls', () => {
    // The reclaim-race idempotency story depends on this: two workers
    // processing the same outbox row must compose the SAME
    // webhook_deliveries.id so the ON CONFLICT DO NOTHING in
    // process_outbox_row collapses the duplicate.
    const a = _deriveDeliveryIdForTests('obx_abc', 'whk_xyz')
    const b = _deriveDeliveryIdForTests('obx_abc', 'whk_xyz')
    expect(a).toBe(b)
    expect(a).toMatch(/^whd_/)
  })

  it('different inputs → different derived ids (no trivial collisions)', () => {
    const a = _deriveDeliveryIdForTests('obx_1', 'whk_A')
    const b = _deriveDeliveryIdForTests('obx_1', 'whk_B')
    const c = _deriveDeliveryIdForTests('obx_2', 'whk_A')
    expect(a).not.toBe(b)
    expect(a).not.toBe(c)
    expect(b).not.toBe(c)
  })

  it('boundary-injection safe: obx_A + whk_B ≠ obx_AB + whk_', () => {
    // The derivation hashes outboxId + '\0' + webhookId. If the null
    // separator were dropped, these two inputs would hash identically.
    // Pin the property so a refactor that inlines concat('_') would fail
    // this test rather than silently introduce a collision class.
    const clean = _deriveDeliveryIdForTests('obx_A', 'whk_B')
    const merged = _deriveDeliveryIdForTests('obx_AB', 'whk_')
    expect(clean).not.toBe(merged)
  })
})
