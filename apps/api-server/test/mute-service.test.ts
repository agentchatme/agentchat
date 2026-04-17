import { describe, it, expect, vi, beforeEach } from 'vitest'

// Service-layer guards for the mute feature. These tests pin the
// validation rules that live *above* the DB CHECK constraints:
//
//   - self-mute rejection (duplicated at the service layer so we fail
//     fast with SELF_MUTE instead of surfacing a DB constraint string)
//   - target_kind whitelist
//   - muted_until parsing (must be future ISO-8601 or null)
//   - target existence lookups (AGENT_NOT_FOUND, CONVERSATION_NOT_FOUND)
//   - NOT_PARTICIPANT for conversation mutes
//   - remove returning NOT_FOUND when no row existed
//
// The DB layer itself is stubbed — we're asserting the service's own
// decisions, not integration behavior.

const findAgentByIdMock = vi.fn()
const findConversationByIdMock = vi.fn()
const isParticipantMock = vi.fn()
const createMuteMock = vi.fn()
const removeMuteMock = vi.fn()
const listMutesMock = vi.fn()
const getMuteStatusMock = vi.fn()

vi.mock('@agentchat/db', () => ({
  findAgentById: findAgentByIdMock,
  findConversationById: findConversationByIdMock,
  isParticipant: isParticipantMock,
  createMute: createMuteMock,
  removeMute: removeMuteMock,
  listMutes: listMutesMock,
  getMuteStatus: getMuteStatusMock,
}))

const {
  createMuteForAgent,
  removeMuteForAgent,
  listMutesForAgent,
  MuteError,
} = await import('../src/services/mute.service.js')

beforeEach(() => {
  findAgentByIdMock.mockReset()
  findConversationByIdMock.mockReset()
  isParticipantMock.mockReset()
  createMuteMock.mockReset()
  removeMuteMock.mockReset()
  listMutesMock.mockReset()
  getMuteStatusMock.mockReset()
})

describe('createMuteForAgent — validation', () => {
  it('rejects self-mute for kind=agent', async () => {
    await expect(
      createMuteForAgent({
        muterAgentId: 'agt_alice',
        targetKind: 'agent',
        targetId: 'agt_alice',
      }),
    ).rejects.toMatchObject({
      name: 'MuteError',
      code: 'SELF_MUTE',
      status: 400,
    })
    // Short-circuit: we never even reach findAgentById or the DB write.
    expect(findAgentByIdMock).not.toHaveBeenCalled()
    expect(createMuteMock).not.toHaveBeenCalled()
  })

  it('allows self-participant muting of a group conversation', async () => {
    findConversationByIdMock.mockResolvedValue({ id: 'conv_group', type: 'group' })
    isParticipantMock.mockResolvedValue(true)
    createMuteMock.mockResolvedValue({
      muter_agent_id: 'agt_alice',
      target_kind: 'conversation',
      target_id: 'conv_group',
      muted_until: null,
      created_at: '2026-04-18T00:00:00Z',
    })

    const row = await createMuteForAgent({
      muterAgentId: 'agt_alice',
      targetKind: 'conversation',
      targetId: 'conv_group',
    })

    expect(row.target_id).toBe('conv_group')
    expect(createMuteMock).toHaveBeenCalledWith({
      muter_agent_id: 'agt_alice',
      target_kind: 'conversation',
      target_id: 'conv_group',
      muted_until: null,
    })
  })

  it('rejects unknown target_kind', async () => {
    await expect(
      createMuteForAgent({
        muterAgentId: 'agt_alice',
        targetKind: 'owner',
        targetId: 'agt_bob',
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      status: 400,
    })
  })

  it('returns AGENT_NOT_FOUND when the target agent does not exist', async () => {
    findAgentByIdMock.mockResolvedValue(null)
    await expect(
      createMuteForAgent({
        muterAgentId: 'agt_alice',
        targetKind: 'agent',
        targetId: 'agt_ghost',
      }),
    ).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND', status: 404 })
    expect(createMuteMock).not.toHaveBeenCalled()
  })

  it('returns CONVERSATION_NOT_FOUND when the target conversation does not exist', async () => {
    findConversationByIdMock.mockResolvedValue(null)
    await expect(
      createMuteForAgent({
        muterAgentId: 'agt_alice',
        targetKind: 'conversation',
        targetId: 'conv_missing',
      }),
    ).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND', status: 404 })
    expect(createMuteMock).not.toHaveBeenCalled()
  })

  it('surfaces real DB errors from findConversationById (does not mask as NOT_FOUND)', async () => {
    // Regression pin: the earlier implementation wrapped getConversation in
    // try/catch and translated *any* throw into CONVERSATION_NOT_FOUND, which
    // silently swallowed transient DB outages as 404s. findConversationById
    // returns null only for "no rows" and re-throws everything else.
    findConversationByIdMock.mockRejectedValue(new Error('connection reset'))
    await expect(
      createMuteForAgent({
        muterAgentId: 'agt_alice',
        targetKind: 'conversation',
        targetId: 'conv_xyz',
      }),
    ).rejects.toThrow('connection reset')
    expect(createMuteMock).not.toHaveBeenCalled()
  })

  it('returns NOT_PARTICIPANT when the muter is not in the conversation', async () => {
    findConversationByIdMock.mockResolvedValue({ id: 'conv_xyz', type: 'group' })
    isParticipantMock.mockResolvedValue(false)
    await expect(
      createMuteForAgent({
        muterAgentId: 'agt_alice',
        targetKind: 'conversation',
        targetId: 'conv_xyz',
      }),
    ).rejects.toMatchObject({ code: 'NOT_PARTICIPANT', status: 403 })
    expect(createMuteMock).not.toHaveBeenCalled()
  })

  it('rejects past/current muted_until (the mute would expire immediately)', async () => {
    await expect(
      createMuteForAgent({
        muterAgentId: 'agt_alice',
        targetKind: 'agent',
        targetId: 'agt_bob',
        mutedUntil: '2000-01-01T00:00:00Z',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 })
    // Validation fires before the existence check.
    expect(findAgentByIdMock).not.toHaveBeenCalled()
  })

  it('rejects non-ISO muted_until strings', async () => {
    await expect(
      createMuteForAgent({
        muterAgentId: 'agt_alice',
        targetKind: 'agent',
        targetId: 'agt_bob',
        mutedUntil: 'next Tuesday',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 })
  })

  it('accepts a valid future muted_until and normalizes it to ISO', async () => {
    findAgentByIdMock.mockResolvedValue({ id: 'agt_bob', handle: 'bob' })
    createMuteMock.mockImplementation(async (row) => ({
      ...row,
      created_at: '2026-04-18T00:00:00Z',
    }))

    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    const row = await createMuteForAgent({
      muterAgentId: 'agt_alice',
      targetKind: 'agent',
      targetId: 'agt_bob',
      mutedUntil: future,
    })

    expect(row.muted_until).toBe(future)
    expect(createMuteMock).toHaveBeenCalledWith(
      expect.objectContaining({ muted_until: future }),
    )
  })

  it('treats null/undefined muted_until as indefinite mute', async () => {
    findAgentByIdMock.mockResolvedValue({ id: 'agt_bob', handle: 'bob' })
    createMuteMock.mockImplementation(async (row) => ({
      ...row,
      created_at: '2026-04-18T00:00:00Z',
    }))

    await createMuteForAgent({
      muterAgentId: 'agt_alice',
      targetKind: 'agent',
      targetId: 'agt_bob',
      mutedUntil: null,
    })
    expect(createMuteMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ muted_until: null }),
    )

    createMuteMock.mockClear()
    await createMuteForAgent({
      muterAgentId: 'agt_alice',
      targetKind: 'agent',
      targetId: 'agt_bob',
    })
    expect(createMuteMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ muted_until: null }),
    )
  })
})

describe('removeMuteForAgent', () => {
  it('throws NOT_FOUND when no row was deleted', async () => {
    removeMuteMock.mockResolvedValue(false)
    await expect(
      removeMuteForAgent({
        muterAgentId: 'agt_alice',
        targetKind: 'agent',
        targetId: 'agt_bob',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 })
  })

  it('resolves cleanly when a row was deleted', async () => {
    removeMuteMock.mockResolvedValue(true)
    await expect(
      removeMuteForAgent({
        muterAgentId: 'agt_alice',
        targetKind: 'agent',
        targetId: 'agt_bob',
      }),
    ).resolves.toBeUndefined()
    expect(removeMuteMock).toHaveBeenCalledWith('agt_alice', 'agent', 'agt_bob')
  })

  it('rejects invalid kind at the route boundary', async () => {
    await expect(
      removeMuteForAgent({
        muterAgentId: 'agt_alice',
        targetKind: 'group', // not a valid kind — the db enum is 'agent' | 'conversation'
        targetId: 'conv_xyz',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 })
    expect(removeMuteMock).not.toHaveBeenCalled()
  })
})

describe('listMutesForAgent', () => {
  it('passes through when no kind filter is given', async () => {
    listMutesMock.mockResolvedValue([])
    await listMutesForAgent('agt_alice')
    expect(listMutesMock).toHaveBeenCalledWith('agt_alice')
  })

  it('forwards a valid kind filter to the DB layer', async () => {
    listMutesMock.mockResolvedValue([])
    await listMutesForAgent('agt_alice', { kind: 'agent' })
    expect(listMutesMock).toHaveBeenCalledWith('agt_alice', { kind: 'agent' })
  })

  it('rejects an invalid kind filter before touching the DB', async () => {
    await expect(
      listMutesForAgent('agt_alice', { kind: 'everything' }),
    ).rejects.toBeInstanceOf(MuteError)
    expect(listMutesMock).not.toHaveBeenCalled()
  })
})
