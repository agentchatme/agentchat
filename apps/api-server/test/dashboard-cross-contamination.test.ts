import { describe, it, expect, vi, beforeEach } from 'vitest'

// Cross-contamination unit tests for dashboard.service.ts. The core
// invariant: owner A must never be able to read or mutate agents owned
// by owner B. Every per-agent service function goes through
// requireOwnedAgent(ownerId, handle), which looks up the agent row and
// then checks owner_agents for a claim row. The service returns 404 —
// not 403 — so a curious owner can't enumerate other owners' agents by
// bouncing off permission errors. See plan §11.6.
//
// Every test here mocks @agentchat/db so no network, no Supabase
// credentials required.

// Mocks must exist before importing the module under test.
const findAgentByHandle = vi.fn()
const findAgentByApiKeyHash = vi.fn()
const findOwnerAgent = vi.fn()
const insertOwnerAgent = vi.fn()
const deleteOwnerAgent = vi.fn()
const listClaimedAgents = vi.fn()
const setPausedByOwner = vi.fn()
const getAgentConversations = vi.fn()
const getConversationMessages = vi.fn()
const getConversation = vi.fn()
const getConversationHide = vi.fn()
const isParticipant = vi.fn()
const listEventsForTarget = vi.fn()

vi.mock('@agentchat/db', () => ({
  findAgentByHandle,
  findAgentByApiKeyHash,
  findOwnerAgent,
  insertOwnerAgent,
  deleteOwnerAgent,
  listClaimedAgents,
  setPausedByOwner,
  getAgentConversations,
  getConversationMessages,
  getConversation,
  getConversationHide,
  isParticipant,
  listEventsForTarget,
}))

const emitEvent = vi.fn().mockResolvedValue(undefined)
vi.mock('../src/services/events.service.js', () => ({
  emitEvent,
}))

const {
  DashboardError,
  claimAgent,
  releaseClaim,
  listAgentsForOwner,
  getAgentProfile,
  getAgentConversationsForOwner,
  getAgentMessagesForOwner,
  getAgentEventsForOwner,
  pauseAgent,
  unpauseAgent,
} = await import('../src/services/dashboard.service.js')

// Two distinct owners + one agent row. The agent is claimed by owner A
// only; all of owner B's requests must be rejected at requireOwnedAgent.
const OWNER_A = 'ownA_aaaaaaaaaaaa'
const OWNER_B = 'ownB_bbbbbbbbbbbb'
const AGENT = {
  id: 'agt_alice',
  handle: 'alice',
  display_name: 'Alice',
  description: 'test agent',
  status: 'active' as const,
  paused_by_owner: 'none' as const,
  email: 'alice@example.com',
  created_at: '2026-01-01T00:00:00Z',
}

function resetAllMocks() {
  findAgentByHandle.mockReset()
  findAgentByApiKeyHash.mockReset()
  findOwnerAgent.mockReset()
  insertOwnerAgent.mockReset()
  deleteOwnerAgent.mockReset()
  listClaimedAgents.mockReset()
  setPausedByOwner.mockReset()
  getAgentConversations.mockReset()
  getConversationMessages.mockReset()
  getConversation.mockReset()
  getConversationHide.mockReset()
  isParticipant.mockReset()
  listEventsForTarget.mockReset()
  emitEvent.mockReset().mockResolvedValue(undefined)
}

// Every read/mutate service function the dashboard exposes, keyed by
// label. Exercising them in one table-driven test proves the 404 path
// is consistently applied — no forgotten code path leaks data.
const SCOPED_FUNCTIONS: Array<{
  label: string
  call: (ownerId: string) => Promise<unknown>
}> = [
  {
    label: 'getAgentProfile',
    call: (ownerId) => getAgentProfile(ownerId, 'alice'),
  },
  {
    label: 'getAgentConversationsForOwner',
    call: (ownerId) => getAgentConversationsForOwner(ownerId, 'alice'),
  },
  {
    label: 'getAgentMessagesForOwner',
    call: (ownerId) => getAgentMessagesForOwner(ownerId, 'alice', 'conv_zzz'),
  },
  {
    label: 'getAgentEventsForOwner',
    call: (ownerId) => getAgentEventsForOwner(ownerId, 'alice'),
  },
  {
    label: 'pauseAgent',
    call: (ownerId) => pauseAgent(ownerId, 'alice', 'send'),
  },
  {
    label: 'unpauseAgent',
    call: (ownerId) => unpauseAgent(ownerId, 'alice'),
  },
  {
    label: 'releaseClaim',
    call: (ownerId) => releaseClaim(ownerId, 'alice'),
  },
]

describe('dashboard.service — cross-contamination (requireOwnedAgent)', () => {
  beforeEach(() => {
    resetAllMocks()
    // By default the handle lookup succeeds — the guard is the
    // owner_agents check, which each test configures per scenario.
    findAgentByHandle.mockResolvedValue(AGENT)
    // findOwnerAgent returns null unless the caller is owner A. This is
    // the single choke point — every scoped function must hit it.
    findOwnerAgent.mockImplementation(async (ownerId: string, agentId: string) => {
      if (ownerId === OWNER_A && agentId === AGENT.id) {
        return { owner_id: OWNER_A, agent_id: AGENT.id, claimed_at: '2026-01-02T00:00:00Z' }
      }
      return null
    })
  })

  for (const { label, call } of SCOPED_FUNCTIONS) {
    it(`${label} rejects owner B with 404 AGENT_NOT_FOUND`, async () => {
      await expect(call(OWNER_B)).rejects.toMatchObject({
        name: 'DashboardError',
        code: 'AGENT_NOT_FOUND',
        status: 404,
      })
      // Must NOT call the underlying mutate/read after the guard fails.
      expect(setPausedByOwner).not.toHaveBeenCalled()
      expect(deleteOwnerAgent).not.toHaveBeenCalled()
      expect(getAgentConversations).not.toHaveBeenCalled()
      expect(listEventsForTarget).not.toHaveBeenCalled()
      expect(emitEvent).not.toHaveBeenCalled()
    })
  }

  it('raises 404 AGENT_NOT_FOUND when the handle itself does not exist', async () => {
    findAgentByHandle.mockResolvedValue(null)
    await expect(getAgentProfile(OWNER_A, 'ghost')).rejects.toMatchObject({
      code: 'AGENT_NOT_FOUND',
      status: 404,
    })
    // owner_agents check should NOT fire — we short-circuit on missing agent.
    expect(findOwnerAgent).not.toHaveBeenCalled()
  })

  it('same 404 code whether the agent exists unclaimed or does not exist at all', async () => {
    // Unclaimed agent → findOwnerAgent returns null → 404.
    const err1 = await getAgentProfile(OWNER_B, 'alice').catch((e) => e)
    // Non-existent agent → findAgentByHandle returns null → 404.
    findAgentByHandle.mockResolvedValueOnce(null)
    const err2 = await getAgentProfile(OWNER_B, 'ghost').catch((e) => e)
    expect(err1).toBeInstanceOf(DashboardError)
    expect(err2).toBeInstanceOf(DashboardError)
    expect(err1.code).toBe('AGENT_NOT_FOUND')
    expect(err2.code).toBe('AGENT_NOT_FOUND')
    expect(err1.status).toBe(404)
    expect(err2.status).toBe(404)
  })
})

describe('dashboard.service — owner A happy path', () => {
  beforeEach(() => {
    resetAllMocks()
    findAgentByHandle.mockResolvedValue(AGENT)
    findOwnerAgent.mockResolvedValue({
      owner_id: OWNER_A,
      agent_id: AGENT.id,
      claimed_at: '2026-01-02T00:00:00Z',
    })
  })

  it('getAgentProfile returns masked email + core fields for the owning owner', async () => {
    const profile = await getAgentProfile(OWNER_A, 'alice')
    expect(profile.id).toBe(AGENT.id)
    expect(profile.handle).toBe('alice')
    expect(profile.paused_by_owner).toBe('none')
    // First char + **** + domain.
    expect(profile.email_masked).toBe('a****@example.com')
  })

  it('pauseAgent writes mode + emits agent.paused with mode metadata', async () => {
    const result = await pauseAgent(OWNER_A, 'alice', 'full')
    expect(setPausedByOwner).toHaveBeenCalledWith(AGENT.id, 'full')
    expect(result.paused_by_owner).toBe('full')
    expect(emitEvent).toHaveBeenCalledWith({
      actorType: 'owner',
      actorId: OWNER_A,
      action: 'agent.paused',
      targetId: AGENT.id,
      metadata: { mode: 'full' },
    })
  })

  it('unpauseAgent writes none + emits agent.unpaused', async () => {
    const result = await unpauseAgent(OWNER_A, 'alice')
    expect(setPausedByOwner).toHaveBeenCalledWith(AGENT.id, 'none')
    expect(result.paused_by_owner).toBe('none')
    expect(emitEvent).toHaveBeenCalledWith({
      actorType: 'owner',
      actorId: OWNER_A,
      action: 'agent.unpaused',
      targetId: AGENT.id,
    })
  })

  it('releaseClaim deletes the owner_agents row + emits agent.released', async () => {
    deleteOwnerAgent.mockResolvedValue(true)
    await releaseClaim(OWNER_A, 'alice')
    expect(deleteOwnerAgent).toHaveBeenCalledWith(OWNER_A, AGENT.id)
    expect(emitEvent).toHaveBeenCalledWith({
      actorType: 'owner',
      actorId: OWNER_A,
      action: 'agent.released',
      targetId: AGENT.id,
    })
  })

  it('releaseClaim surfaces CLAIM_NOT_FOUND if the delete found nothing', async () => {
    deleteOwnerAgent.mockResolvedValue(false)
    await expect(releaseClaim(OWNER_A, 'alice')).rejects.toMatchObject({
      code: 'CLAIM_NOT_FOUND',
      status: 404,
    })
    expect(emitEvent).not.toHaveBeenCalled()
  })

  it('getAgentMessagesForOwner rejects with 404 when the agent is not a participant', async () => {
    // Crafted conversation id — alice is not a member. The guard here
    // is separate from the owner-agent check because the conversation id
    // comes from the query string, not the URL path.
    isParticipant.mockResolvedValue(false)
    await expect(
      getAgentMessagesForOwner(OWNER_A, 'alice', 'conv_foreign'),
    ).rejects.toMatchObject({
      code: 'CONVERSATION_NOT_FOUND',
      status: 404,
    })
    expect(getConversation).not.toHaveBeenCalled()
    expect(getConversationMessages).not.toHaveBeenCalled()
  })

  it('getAgentMessagesForOwner forwards the agent id + beforeSeq when the agent is a member', async () => {
    isParticipant.mockResolvedValue(true)
    getConversation.mockResolvedValue({ id: 'conv_ok', type: 'direct' })
    getConversationHide.mockResolvedValue(null)
    getConversationMessages.mockResolvedValue([])
    await getAgentMessagesForOwner(OWNER_A, 'alice', 'conv_ok', 42)
    expect(getConversationMessages).toHaveBeenCalledWith(
      'conv_ok',
      AGENT.id,
      50,
      42,
      null,
      { scopeToRecipient: false },
    )
  })

  it('getAgentMessagesForOwner sets scopeToRecipient=true for group conversations', async () => {
    isParticipant.mockResolvedValue(true)
    getConversation.mockResolvedValue({ id: 'grp_x', type: 'group' })
    getConversationHide.mockResolvedValue(null)
    getConversationMessages.mockResolvedValue([])
    await getAgentMessagesForOwner(OWNER_A, 'alice', 'grp_x')
    expect(getConversationMessages).toHaveBeenCalledWith(
      'grp_x',
      AGENT.id,
      50,
      undefined,
      null,
      { scopeToRecipient: true },
    )
  })
})

describe('dashboard.service — claimAgent', () => {
  beforeEach(() => {
    resetAllMocks()
  })

  it('rejects with 404 INVALID_API_KEY when the hash is unknown', async () => {
    findAgentByApiKeyHash.mockResolvedValue(null)
    await expect(claimAgent(OWNER_A, 'ac_totally_fake_key')).rejects.toMatchObject({
      code: 'INVALID_API_KEY',
      status: 404,
    })
    expect(insertOwnerAgent).not.toHaveBeenCalled()
    expect(emitEvent).not.toHaveBeenCalled()
  })

  it('rejects with 404 INVALID_API_KEY when the matched agent is deleted', async () => {
    findAgentByApiKeyHash.mockResolvedValue({ ...AGENT, status: 'deleted' })
    await expect(claimAgent(OWNER_A, 'ac_deleted_agent')).rejects.toMatchObject({
      code: 'INVALID_API_KEY',
      status: 404,
    })
    expect(insertOwnerAgent).not.toHaveBeenCalled()
  })

  it('rejects with 409 ALREADY_CLAIMED when the insert hits a duplicate-key error', async () => {
    findAgentByApiKeyHash.mockResolvedValue(AGENT)
    insertOwnerAgent.mockRejectedValue(
      new Error('duplicate key value violates unique constraint "owner_agents_pkey"'),
    )
    await expect(claimAgent(OWNER_A, 'ac_duplicate')).rejects.toMatchObject({
      code: 'ALREADY_CLAIMED',
      status: 409,
    })
    expect(emitEvent).not.toHaveBeenCalled()
  })

  it('on success, inserts owner_agents, emits agent.claimed, returns the claimed shape', async () => {
    findAgentByApiKeyHash.mockResolvedValue(AGENT)
    insertOwnerAgent.mockResolvedValue(undefined)
    const claimed = await claimAgent(OWNER_A, 'ac_valid_key')
    expect(insertOwnerAgent).toHaveBeenCalledWith({
      owner_id: OWNER_A,
      agent_id: AGENT.id,
    })
    expect(emitEvent).toHaveBeenCalledWith({
      actorType: 'owner',
      actorId: OWNER_A,
      action: 'agent.claimed',
      targetId: AGENT.id,
    })
    expect(claimed.id).toBe(AGENT.id)
    expect(claimed.handle).toBe('alice')
    expect(claimed.paused_by_owner).toBe('none')
  })

  it('sha-256 hashes the API key before the DB lookup — not the raw key', async () => {
    findAgentByApiKeyHash.mockResolvedValue(null)
    await claimAgent(OWNER_A, 'ac_raw_secret').catch(() => {})
    const [arg] = findAgentByApiKeyHash.mock.calls[0] ?? []
    // sha-256 of 'ac_raw_secret' is 64 hex chars and must not equal the raw key.
    expect(typeof arg).toBe('string')
    expect(arg).toHaveLength(64)
    expect(arg).not.toBe('ac_raw_secret')
    expect(/^[a-f0-9]{64}$/.test(arg as string)).toBe(true)
  })
})

describe('dashboard.service — listAgentsForOwner', () => {
  beforeEach(() => resetAllMocks())

  it('filters out soft-deleted agent rows', async () => {
    listClaimedAgents.mockResolvedValue([
      {
        claimed_at: '2026-01-02T00:00:00Z',
        agents: { ...AGENT, id: 'agt_live', handle: 'live' },
      },
      {
        claimed_at: '2026-01-02T00:00:00Z',
        agents: { ...AGENT, id: 'agt_gone', handle: 'gone', status: 'deleted' },
      },
    ])
    const result = await listAgentsForOwner(OWNER_A)
    expect(result).toHaveLength(1)
    expect(result[0]?.handle).toBe('live')
  })

  it('handles the embedded PostgREST shape whether agents is an array or object', async () => {
    listClaimedAgents.mockResolvedValue([
      {
        claimed_at: '2026-01-02T00:00:00Z',
        agents: [{ ...AGENT, id: 'agt_obj', handle: 'obj' }],
      },
    ])
    const result = await listAgentsForOwner(OWNER_A)
    expect(result).toHaveLength(1)
    expect(result[0]?.handle).toBe('obj')
  })
})
