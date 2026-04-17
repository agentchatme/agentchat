import {
  createMute,
  removeMute,
  listMutes,
  getMuteStatus,
  findAgentById,
  getConversation,
  isParticipant,
  type MuteRow,
  type MuteTargetKind,
} from '@agentchat/db'

// Typed error mirroring ContactError so route handlers can map
// (code, status) to HTTP the same way. Keeping the shape identical avoids
// a second error-mapping helper in the route layer.
export class MuteError extends Error {
  code: string
  status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'MuteError'
    this.code = code
    this.status = status
  }
}

const VALID_KINDS: ReadonlySet<MuteTargetKind> = new Set(['agent', 'conversation'])

/**
 * Parse muted_until:
 *   - undefined / null  → indefinite mute (muted_until = null)
 *   - ISO string        → must be a valid future instant
 *
 * We reject past/present timestamps here because a mute that expires the
 * moment it's created is noise — the caller almost certainly meant a
 * different unit (e.g. passed seconds instead of ms, or an already-stale
 * "for the next 8 hours" value from a queued request). Failing loud beats
 * silently no-op-ing.
 */
function parseMutedUntil(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') {
    throw new MuteError('VALIDATION_ERROR', 'muted_until must be an ISO-8601 string or null', 400)
  }
  const ts = Date.parse(raw)
  if (Number.isNaN(ts)) {
    throw new MuteError('VALIDATION_ERROR', 'muted_until is not a valid ISO-8601 timestamp', 400)
  }
  if (ts <= Date.now()) {
    throw new MuteError('VALIDATION_ERROR', 'muted_until must be in the future', 400)
  }
  return new Date(ts).toISOString()
}

function assertValidKind(kind: string): asserts kind is MuteTargetKind {
  if (!VALID_KINDS.has(kind as MuteTargetKind)) {
    throw new MuteError(
      'VALIDATION_ERROR',
      `target_kind must be 'agent' or 'conversation', got '${kind}'`,
      400,
    )
  }
}

export interface CreateMuteInput {
  muterAgentId: string
  targetKind: string
  targetId: string
  mutedUntil?: string | null
}

/**
 * Create (or refresh) a mute.
 *
 * Pre-checks run in the service layer so we can return a precise error
 * code (AGENT_NOT_FOUND vs CONVERSATION_NOT_FOUND vs NOT_PARTICIPANT)
 * without relying on the DB's FK error strings. The underlying upsert is
 * idempotent on (muter, kind, target_id) so a retry with a new expiry
 * refreshes the row instead of erroring.
 *
 * Policy calls:
 *   - Self-mute for kind=agent is rejected at the service AND the DB
 *     (CHECK constraint mutes_no_self_agent). Duplicate enforcement is
 *     intentional: it means direct SQL and a future RPC path both stay
 *     safe even if a caller bypasses the service.
 *   - Self-mute for kind=conversation is allowed — you can reasonably
 *     mute a group you're a member of (to stop waking up on every chatty
 *     message) without wanting to leave it.
 *   - kind=conversation requires the muter to be an *active* participant.
 *     Muting a conversation you can't see is meaningless and we don't
 *     want the table accumulating dangling rows from agents that were
 *     removed from a group.
 */
export async function createMuteForAgent(input: CreateMuteInput): Promise<MuteRow> {
  const { muterAgentId, targetKind, targetId } = input
  assertValidKind(targetKind)

  if (!targetId || typeof targetId !== 'string') {
    throw new MuteError('VALIDATION_ERROR', 'target_id is required', 400)
  }

  const mutedUntil = parseMutedUntil(input.mutedUntil)

  if (targetKind === 'agent') {
    if (targetId === muterAgentId) {
      throw new MuteError('SELF_MUTE', 'Cannot mute yourself', 400)
    }
    const target = await findAgentById(targetId)
    if (!target) {
      throw new MuteError('AGENT_NOT_FOUND', `Agent ${targetId} not found`, 404)
    }
  } else {
    // targetKind === 'conversation'
    let convo: Awaited<ReturnType<typeof getConversation>> | null = null
    try {
      convo = await getConversation(targetId)
    } catch {
      // getConversation throws on "no rows" via .single(); treat as 404.
      convo = null
    }
    if (!convo) {
      throw new MuteError('CONVERSATION_NOT_FOUND', `Conversation ${targetId} not found`, 404)
    }
    const participant = await isParticipant(targetId, muterAgentId)
    if (!participant) {
      throw new MuteError(
        'NOT_PARTICIPANT',
        'You must be a participant of the conversation to mute it',
        403,
      )
    }
  }

  return createMute({
    muter_agent_id: muterAgentId,
    target_kind: targetKind,
    target_id: targetId,
    muted_until: mutedUntil,
  })
}

export interface RemoveMuteInput {
  muterAgentId: string
  targetKind: string
  targetId: string
}

/**
 * Remove a mute. Throws NOT_FOUND if no row existed — the route handler
 * turns that into a 404 so a double-unmute from a flaky client is visible
 * rather than silently swallowed.
 */
export async function removeMuteForAgent(input: RemoveMuteInput): Promise<void> {
  const { muterAgentId, targetKind, targetId } = input
  assertValidKind(targetKind)

  const existed = await removeMute(muterAgentId, targetKind, targetId)
  if (!existed) {
    throw new MuteError('NOT_FOUND', 'No active mute found for that target', 404)
  }
}

/**
 * List the muter's active mutes. Expired rows are filtered server-side
 * in the query layer (listMutes), so the response only contains mutes
 * the caller can still expect to be in effect.
 */
export async function listMutesForAgent(
  muterAgentId: string,
  opts: { kind?: string } = {},
): Promise<MuteRow[]> {
  if (opts.kind !== undefined) {
    assertValidKind(opts.kind)
    return listMutes(muterAgentId, { kind: opts.kind })
  }
  return listMutes(muterAgentId)
}

/**
 * Single-target lookup. Returns null if no active mute exists. Used by
 * the GET /v1/mutes/:kind/:id route so a client can probe mute state
 * without fetching the full list.
 */
export async function getMuteForAgent(
  muterAgentId: string,
  targetKind: string,
  targetId: string,
): Promise<MuteRow | null> {
  assertValidKind(targetKind)
  return getMuteStatus(muterAgentId, targetKind, targetId)
}
