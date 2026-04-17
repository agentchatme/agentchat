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
// requireOwnedAgent used to be a pair of calls (findAgentByHandle +
// findOwnerAgent); it is now one PostgREST inner-join via
// findOwnedAgentByHandle, so the mock surface collapses accordingly.
// The security semantics are unchanged: null return → 404 AGENT_NOT_FOUND.
//
// getAgentMessagesForOwner used to be a ladder of four queries
// (isParticipant → getConversation → getConversationHide →
// getConversationMessages); it is now a single RPC call via
// getAgentMessagesForOwnerRPC (migration 023). Security-critical
// behaviors like sender_id stripping and recipient-scoped delivery
// envelopes happen inside the RPC and are tested via integration
// rather than at this unit layer.
const findOwnedAgentByHandle = vi.fn()
const findAgentByApiKeyHash = vi.fn()
const insertOwnerAgent = vi.fn()
const deleteOwnerAgent = vi.fn()
const listClaimedAgents = vi.fn()
const setPausedByOwner = vi.fn()
const getAgentConversations = vi.fn()
const getAgentMessagesForOwnerRPC = vi.fn()
const listEventsForTarget = vi.fn()
const listContacts = vi.fn()
const listBlocks = vi.fn()
const invalidateOwnerCache = vi.fn().mockResolvedValue(undefined)

vi.mock('@agentchat/db', () => ({
  findOwnedAgentByHandle,
  findAgentByApiKeyHash,
  insertOwnerAgent,
  deleteOwnerAgent,
  listClaimedAgents,
  setPausedByOwner,
  getAgentConversations,
  getAgentMessagesForOwnerRPC,
  listEventsForTarget,
  listContacts,
  listBlocks,
  invalidateOwnerCache,
}))

// Stub env so importing dashboard.service.ts (which now transitively
// loads avatar.service.ts → env.ts) doesn't trip the real env
// validator in a no-credential test environment.
vi.mock('../src/env.js', () => ({
  env: {
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-key',
    UPSTASH_REDIS_REST_URL: 'https://test.upstash.io',
    UPSTASH_REDIS_REST_TOKEN: 'test-token',
    AVATARS_BUCKET: 'avatars',
  },
}))

const emitEvent = vi.fn().mockResolvedValue(undefined)
vi.mock('../src/services/events.service.js', () => ({
  emitEvent,
}))

// The claimAgent path touches the per-agent fail-counter bucket in
// Redis before running the DB insert. The Upstash client initializes
// lazily and, in a no-credential test environment, blocks the event
// loop trying to connect — which surfaces as the 5s test timeout on
// every claimAgent test. Mocking the module out is both faster and
// semantically correct: rate-limit behavior is exercised in its own
// unit file, and these tests are specifically about cross-
// contamination and wire-shape invariants in dashboard.service.
const peekRateLimitCounter = vi.fn().mockResolvedValue(0)
const incrRateLimitCounter = vi.fn().mockResolvedValue(1)
const rateLimitBucketKey = vi.fn(
  (prefix: string, key: string, windowSecs: number) => `${prefix}:${key}:${windowSecs}`,
)
vi.mock('../src/middleware/rate-limit.js', () => ({
  peekRateLimitCounter,
  incrRateLimitCounter,
  rateLimitBucketKey,
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
  getAgentContactsForOwner,
  getAgentBlocksForOwner,
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
  findOwnedAgentByHandle.mockReset()
  findAgentByApiKeyHash.mockReset()
  insertOwnerAgent.mockReset()
  deleteOwnerAgent.mockReset()
  listClaimedAgents.mockReset()
  setPausedByOwner.mockReset()
  getAgentConversations.mockReset()
  getAgentMessagesForOwnerRPC.mockReset()
  listEventsForTarget.mockReset()
  listContacts.mockReset()
  listBlocks.mockReset()
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
  {
    label: 'getAgentContactsForOwner',
    call: (ownerId) => getAgentContactsForOwner(ownerId, 'alice'),
  },
  {
    label: 'getAgentBlocksForOwner',
    call: (ownerId) => getAgentBlocksForOwner(ownerId, 'alice'),
  },
]

describe('dashboard.service — cross-contamination (requireOwnedAgent)', () => {
  beforeEach(() => {
    resetAllMocks()
    // The join returns the agent row only when the caller is owner A.
    // Any other (owner, handle) pair — unknown handle, claimed by
    // someone else, known handle + wrong owner — resolves to null, and
    // the service surfaces that uniformly as 404 AGENT_NOT_FOUND so a
    // curious owner cannot distinguish "doesn't exist" from "not yours".
    findOwnedAgentByHandle.mockImplementation(
      async (ownerId: string, handle: string) => {
        if (ownerId === OWNER_A && handle === AGENT.handle) return AGENT
        return null
      },
    )
    // getAgentMessagesForOwner bypasses findOwnedAgentByHandle entirely
    // and defers to the get_agent_messages_for_owner RPC (migration 023),
    // which performs the ownership check in SQL. Mirror that fail-closed
    // behavior here: owner A succeeds, anyone else gets AGENT_NOT_FOUND.
    getAgentMessagesForOwnerRPC.mockImplementation(
      async ({ owner_id, handle }: { owner_id: string; handle: string }) => {
        if (owner_id === OWNER_A && handle === AGENT.handle) return []
        throw new Error('AGENT_NOT_FOUND')
      },
    )
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
    await expect(getAgentProfile(OWNER_A, 'ghost')).rejects.toMatchObject({
      code: 'AGENT_NOT_FOUND',
      status: 404,
    })
  })

  it('same 404 code whether the agent exists unclaimed or does not exist at all', async () => {
    // Unclaimed agent: known handle but wrong owner → null → 404.
    const err1 = await getAgentProfile(OWNER_B, 'alice').catch((e) => e)
    // Non-existent agent: unknown handle → null → 404.
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
    findOwnedAgentByHandle.mockResolvedValue(AGENT)
  })

  it('getAgentProfile returns masked email + core fields for the owning owner', async () => {
    const profile = await getAgentProfile(OWNER_A, 'alice')
    expect(profile.handle).toBe('alice')
    expect(profile.paused_by_owner).toBe('none')
    // First char + **** + domain.
    expect(profile.email_masked).toBe('a****@example.com')
  })

  it('getAgentProfile must NOT expose internal agent.id on the wire', async () => {
    const profile = await getAgentProfile(OWNER_A, 'alice')
    // The dashboard addresses every agent by @handle. Internal row ids
    // are stripped in dashboard.service.ts — guard that at the unit level
    // so a regression here gets caught before shipping.
    expect((profile as Record<string, unknown>)['id']).toBeUndefined()
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

  it('getAgentMessagesForOwner rejects with 404 CONVERSATION_NOT_FOUND when the RPC raises it', async () => {
    // The RPC raises named exceptions when the claimed agent is not a
    // participant OR the conversation does not exist. The service layer
    // must translate both paths to a 404 so a crafted conversation id
    // cannot be used to enumerate conversations the agent does not own.
    getAgentMessagesForOwnerRPC.mockRejectedValueOnce(new Error('CONVERSATION_NOT_FOUND'))
    await expect(
      getAgentMessagesForOwner(OWNER_A, 'alice', 'conv_foreign'),
    ).rejects.toMatchObject({
      code: 'CONVERSATION_NOT_FOUND',
      status: 404,
    })
  })

  it('getAgentMessagesForOwner rejects with 404 AGENT_NOT_FOUND when the RPC raises it', async () => {
    // Ownership is enforced inside the RPC (migration 023), so the
    // service catches AGENT_NOT_FOUND from the RPC and maps it to the
    // same 404 the rest of the dashboard surface uses.
    getAgentMessagesForOwnerRPC.mockRejectedValueOnce(new Error('AGENT_NOT_FOUND'))
    await expect(
      getAgentMessagesForOwner(OWNER_A, 'alice', 'conv_any'),
    ).rejects.toMatchObject({
      code: 'AGENT_NOT_FOUND',
      status: 404,
    })
  })

  it('getAgentMessagesForOwner forwards owner id, handle, conversation id and beforeSeq to the RPC', async () => {
    getAgentMessagesForOwnerRPC.mockResolvedValueOnce([])
    await getAgentMessagesForOwner(OWNER_A, 'alice', 'conv_ok', 42)
    expect(getAgentMessagesForOwnerRPC).toHaveBeenCalledWith({
      owner_id: OWNER_A,
      handle: 'alice',
      conversation_id: 'conv_ok',
      before_seq: 42,
      limit: 50,
    })
  })

  it('getAgentMessagesForOwner returns RPC rows unchanged — no sender_id, is_own already set', async () => {
    // The RPC strips sender_id in-SQL and emits is_own (boolean) so the
    // service can forward its rows directly. This test pins that
    // contract: the service must NOT re-shape rows. If someone
    // re-introduces a `.map(...)` here, it will break the recipient-
    // scoped delivery envelope fields (delivery_id, status, delivered_at,
    // read_at) that the RPC emits and the dashboard depends on.
    const rpcRows = [
      {
        id: 'msg_self',
        client_msg_id: 'cli_1',
        conversation_id: 'conv_ok',
        seq: 1,
        type: 'text',
        content: { text: 'hi' },
        metadata: {},
        created_at: '2026-01-03T00:00:00Z',
        is_own: true,
        delivery_id: 'del_1',
        status: 'read',
        delivered_at: '2026-01-03T00:00:01Z',
        read_at: '2026-01-03T00:00:02Z',
      },
      {
        id: 'msg_other',
        client_msg_id: 'cli_2',
        conversation_id: 'conv_ok',
        seq: 2,
        type: 'text',
        content: { text: 'hello' },
        metadata: {},
        created_at: '2026-01-03T00:01:00Z',
        is_own: false,
        delivery_id: 'del_2',
        status: 'delivered',
        delivered_at: '2026-01-03T00:01:01Z',
        read_at: null,
      },
    ]
    getAgentMessagesForOwnerRPC.mockResolvedValueOnce(rpcRows)
    const result = await getAgentMessagesForOwner(OWNER_A, 'alice', 'conv_ok')
    expect(result).toEqual(rpcRows)
    for (const m of result) {
      expect((m as Record<string, unknown>)['sender_id']).toBeUndefined()
    }
  })

  it('getAgentEventsForOwner strips actor_id/target_id and filters metadata to a whitelist', async () => {
    listEventsForTarget.mockResolvedValue([
      {
        id: 'evt_1',
        actor_type: 'owner',
        actor_id: OWNER_A, // internal — must be stripped
        action: 'agent.paused',
        target_id: AGENT.id, // internal — must be stripped
        metadata: { mode: 'full', secret: 'leak' }, // 'secret' not whitelisted
        created_at: '2026-01-03T00:00:00Z',
      },
      {
        id: 'evt_2',
        actor_type: 'system',
        actor_id: 'system',
        action: 'agent.claim_revoked',
        target_id: AGENT.id,
        metadata: { owner_id: 'ownX_leak', reason: 'key_rotated' },
        created_at: '2026-01-03T00:01:00Z',
      },
      {
        id: 'evt_3',
        actor_type: 'owner',
        actor_id: OWNER_A,
        action: 'agent.claimed',
        target_id: AGENT.id,
        metadata: {},
        created_at: '2026-01-03T00:02:00Z',
      },
    ])
    const events = await getAgentEventsForOwner(OWNER_A, 'alice')
    expect(events).toHaveLength(3)
    for (const e of events) {
      const rec = e as Record<string, unknown>
      expect(rec['actor_id']).toBeUndefined()
      expect(rec['target_id']).toBeUndefined()
    }
    // agent.paused keeps mode, drops secret.
    expect((events[0] as Record<string, unknown>)['metadata']).toEqual({ mode: 'full' })
    // agent.claim_revoked keeps reason, drops owner_id.
    expect((events[1] as Record<string, unknown>)['metadata']).toEqual({ reason: 'key_rotated' })
    // agent.claimed starts with empty metadata and stays empty.
    expect((events[2] as Record<string, unknown>)['metadata']).toEqual({})
  })

  // ─── avatar_key → avatar_url translation ────────────────────────────
  // Migration 035 persists an opaque storage key on agents; migration 036
  // extends that into the contacts/blocks return shapes. The wire-contract
  // invariant is that the dashboard sees `avatar_url` (a full public URL)
  // and NEVER `avatar_key` (the raw storage path). These tests pin that
  // translation at the dashboard.service boundary.

  it('getAgentContactsForOwner translates avatar_key → avatar_url and strips the raw key', async () => {
    listContacts.mockResolvedValue({
      contacts: [
        {
          handle: 'bob',
          display_name: 'Bob',
          description: null,
          notes: null,
          added_at: '2026-02-01T00:00:00Z',
          avatar_key: 'deadbeef00112233/abc123.webp',
        },
        {
          handle: 'carol',
          display_name: 'Carol',
          description: null,
          notes: 'from group X',
          added_at: '2026-02-02T00:00:00Z',
          avatar_key: null, // no avatar uploaded yet
        },
      ],
      total: 2,
      limit: 100,
      offset: 0,
    })

    const result = await getAgentContactsForOwner(OWNER_A, 'alice')

    expect(result.contacts).toHaveLength(2)
    const [bob, carol] = result.contacts

    // avatar_url assembled from the stubbed SUPABASE_URL + bucket + key.
    expect((bob as Record<string, unknown>)['avatar_url']).toBe(
      'https://test.supabase.co/storage/v1/object/public/avatars/deadbeef00112233/abc123.webp',
    )
    // null avatar_key → null avatar_url (the "no picture" fallback).
    expect((carol as Record<string, unknown>)['avatar_url']).toBeNull()

    // The raw storage key must NOT leak onto the wire.
    for (const row of result.contacts) {
      expect((row as Record<string, unknown>)['avatar_key']).toBeUndefined()
    }
  })

  it('getAgentBlocksForOwner translates avatar_key → avatar_url and strips the raw key', async () => {
    listBlocks.mockResolvedValue({
      blocks: [
        {
          handle: 'dave',
          display_name: null,
          avatar_key: 'ff00ee11dd22cc33/xyz789.webp',
          blocked_at: '2026-03-10T00:00:00Z',
        },
      ],
      total: 1,
      limit: 100,
      offset: 0,
    })

    const result = await getAgentBlocksForOwner(OWNER_A, 'alice')

    expect(result.blocks).toHaveLength(1)
    const [dave] = result.blocks
    expect((dave as Record<string, unknown>)['avatar_url']).toBe(
      'https://test.supabase.co/storage/v1/object/public/avatars/ff00ee11dd22cc33/xyz789.webp',
    )
    expect((dave as Record<string, unknown>)['avatar_key']).toBeUndefined()
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

  it('rejects with 409 ALREADY_CLAIMED and emits agent.claim_attempted on the incumbent', async () => {
    findAgentByApiKeyHash.mockResolvedValue(AGENT)
    insertOwnerAgent.mockRejectedValue(
      new Error('duplicate key value violates unique constraint "owner_agents_pkey"'),
    )
    await expect(claimAgent(OWNER_A, 'ac_duplicate')).rejects.toMatchObject({
      code: 'ALREADY_CLAIMED',
      status: 409,
    })
    // Failed-claim path must emit exactly ONE event: agent.claim_attempted
    // on the target agent. Never agent.claimed, which is reserved for the
    // successful insert path below. Without this event the incumbent
    // owner's activity feed would silently hide probing attempts.
    expect(emitEvent).toHaveBeenCalledTimes(1)
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'owner',
        actorId: OWNER_A,
        action: 'agent.claim_attempted',
        targetId: AGENT.id,
      }),
    )
    // And the per-agent fail counter must be bumped so distributed probes
    // trip TOO_MANY_CLAIMS on their next attempt.
    expect(incrRateLimitCounter).toHaveBeenCalled()
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
    expect(claimed.handle).toBe('alice')
    expect(claimed.paused_by_owner).toBe('none')
    // Same no-internal-ids guard as getAgentProfile — claimAgent must
    // never leak the internal agent row id on the wire.
    expect((claimed as Record<string, unknown>)['id']).toBeUndefined()
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
