import { createHash } from 'node:crypto'
import {
  findAgentByApiKeyHash,
  findAgentByHandle,
  findOwnerAgent,
  insertOwnerAgent,
  listClaimedAgents,
  deleteOwnerAgent,
  setPausedByOwner,
  getAgentConversations,
  getConversationMessages,
  getConversation,
  getConversationHide,
  isParticipant,
  listEventsForTarget,
  listContacts,
  listBlocks,
} from '@agentchat/db'
import { emitEvent } from './events.service.js'
import {
  peekRateLimitCounter,
  incrRateLimitCounter,
  rateLimitBucketKey,
} from '../middleware/rate-limit.js'

// ─── Per-agent claim rate limit ────────────────────────────────────────────
// Second layer behind the /agents/claim IP limiter. The IP limit blunts a
// single-host attacker; this one catches a distributed probe against ONE
// specific agent (different IPs, same target). We only count FAILED
// (ALREADY_CLAIMED) attempts so a legit owner mis-typing their own key
// doesn't trip the limiter.
const CLAIM_FAIL_WINDOW_SECS = 600
const CLAIM_FAIL_MAX = 5

// ─── Dashboard service errors ──────────────────────────────────────────────
// The dashboard API uses 404 for "you don't own this agent" cases to avoid
// leaking existence. The service layer raises DashboardError with a code and
// status; the route maps it to a response. See plan §11.6.

export class DashboardError extends Error {
  code: string
  status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'DashboardError'
    this.code = code
    this.status = status
  }
}

// ─── Shared scope check ────────────────────────────────────────────────────
// Every per-agent dashboard route starts by resolving the :handle param to
// the agent row AND verifying the caller's owner_agents claim. If either
// the agent doesn't exist OR the caller hasn't claimed it, return 404 —
// not 403 — so a curious owner can't enumerate other owners' agents.

async function requireOwnedAgent(ownerId: string, handle: string) {
  const agent = await findAgentByHandle(handle)
  if (!agent) {
    throw new DashboardError('AGENT_NOT_FOUND', `Account @${handle} not found`, 404)
  }
  const claim = await findOwnerAgent(ownerId, agent.id)
  if (!claim) {
    throw new DashboardError('AGENT_NOT_FOUND', `Account @${handle} not found`, 404)
  }
  return agent
}

// ─── Claim ─────────────────────────────────────────────────────────────────
// Owner pastes an API key → we hash it → look up the agent → insert the
// claim. Returns 404 INVALID_API_KEY if the hash doesn't match any live
// agent. Returns 409 ALREADY_CLAIMED on a second claim (enforced by the
// agent_id PK on owner_agents — unique-violation maps here). Every blocked
// attempt (409) ALSO emits an `agent.claim_attempted` event on the target
// agent so the incumbent sees the probe in their activity feed, plus bumps
// a per-agent Redis counter that short-circuits further attempts at the
// TOO_MANY_CLAIMS threshold.
//
// `context` carries the request IP and truncated user-agent so the audit
// event has enough fingerprint to distinguish one attempt from another.
// Both are optional so unit tests / internal callers can skip them.

export async function claimAgent(
  ownerId: string,
  apiKey: string,
  context?: { ip?: string; userAgent?: string },
) {
  const hash = createHash('sha256').update(apiKey).digest('hex')
  const agent = await findAgentByApiKeyHash(hash)
  if (!agent) {
    throw new DashboardError('INVALID_API_KEY', 'No agent matches that API key', 404)
  }
  if (agent.status === 'deleted') {
    throw new DashboardError('INVALID_API_KEY', 'No agent matches that API key', 404)
  }

  // Per-agent fail counter peek. If a distributed probe has already run up
  // CLAIM_FAIL_MAX failures inside the window, short-circuit with 429 so
  // we don't even try the insert. The legit owner's first successful claim
  // never increments this counter, so an owner who eventually pastes the
  // right key is unaffected.
  const failBucket = rateLimitBucketKey(
    'claim_fail_agent',
    agent.id as string,
    CLAIM_FAIL_WINDOW_SECS,
  )
  const failCount = await peekRateLimitCounter(failBucket)
  if (failCount >= CLAIM_FAIL_MAX) {
    throw new DashboardError(
      'TOO_MANY_CLAIMS',
      'This agent has seen too many claim attempts. Please try again later.',
      429,
    )
  }

  try {
    await insertOwnerAgent({ owner_id: ownerId, agent_id: agent.id })
  } catch (e) {
    const msg = e instanceof Error ? e.message : ''
    if (msg.includes('duplicate') || msg.includes('unique') || msg.includes('owner_agents_pkey')) {
      // Bump the per-agent counter and emit an audit event so the
      // incumbent's activity feed surfaces the probe. The actor_id is
      // stored for incident response but sanitizeEvent strips it before
      // returning to the dashboard — the incumbent sees "someone tried"
      // without learning WHO.
      await incrRateLimitCounter(failBucket, CLAIM_FAIL_WINDOW_SECS)
      await emitEvent({
        actorType: 'owner',
        actorId: ownerId,
        action: 'agent.claim_attempted',
        targetId: agent.id as string,
        metadata: {
          ip: context?.ip ?? 'unknown',
          user_agent: truncateUserAgent(context?.userAgent),
        },
      })
      throw new DashboardError(
        'ALREADY_CLAIMED',
        'This agent is already claimed by another dashboard owner',
        409,
      )
    }
    throw e
  }

  await emitEvent({
    actorType: 'owner',
    actorId: ownerId,
    action: 'agent.claimed',
    targetId: agent.id,
  })

  // Wire shape intentionally omits agent.id — the dashboard identifies
  // every agent by @handle. Internal row ids are never surfaced to the
  // browser. Same rule applies to listAgentsForOwner / getAgentProfile
  // / pauseAgent / unpauseAgent below.
  return {
    handle: agent.handle,
    display_name: agent.display_name,
    description: agent.description,
    status: agent.status,
    paused_by_owner: agent.paused_by_owner ?? 'none',
    claimed_at: new Date().toISOString(),
    created_at: agent.created_at,
  }
}

// ─── Release ───────────────────────────────────────────────────────────────
// Drops the owner_agents row. Does NOT delete the agent or rotate its key
// — release is cosmetic from the agent's perspective. Idempotent-ish: a
// release that finds no claim surfaces 404 so the frontend can react.

export async function releaseClaim(ownerId: string, handle: string) {
  const agent = await requireOwnedAgent(ownerId, handle)
  const deleted = await deleteOwnerAgent(ownerId, agent.id)
  if (!deleted) {
    throw new DashboardError('CLAIM_NOT_FOUND', 'Claim not found', 404)
  }
  await emitEvent({
    actorType: 'owner',
    actorId: ownerId,
    action: 'agent.released',
    targetId: agent.id,
  })
}

// ─── List / profile ────────────────────────────────────────────────────────

export async function listAgentsForOwner(ownerId: string) {
  const rows = await listClaimedAgents(ownerId)
  // PostgREST returns the embedded `agents` row; flatten + normalize so
  // the wire shape matches ClaimedAgent.
  return rows
    .map((r) => {
      const agent = Array.isArray(r.agents) ? r.agents[0] : r.agents
      if (!agent) return null
      const status = agent.status as string
      if (status === 'deleted') return null
      return {
        handle: agent.handle as string,
        display_name: (agent.display_name as string | null) ?? null,
        description: (agent.description as string | null) ?? null,
        status,
        paused_by_owner: (agent.paused_by_owner as string | null) ?? 'none',
        claimed_at: r.claimed_at as string,
        created_at: agent.created_at as string,
      }
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
}

export async function getAgentProfile(ownerId: string, handle: string) {
  const agent = await requireOwnedAgent(ownerId, handle)
  return {
    handle: agent.handle,
    display_name: agent.display_name,
    description: agent.description,
    status: agent.status,
    paused_by_owner: agent.paused_by_owner ?? 'none',
    email_masked: maskEmail(agent.email as string),
    created_at: agent.created_at,
  }
}

function maskEmail(email: string): string {
  const at = email.indexOf('@')
  if (at <= 0) return email
  const first = email[0] ?? ''
  return `${first}****@${email.slice(at + 1)}`
}

// Keep audit UA strings bounded so a pathological client can't balloon
// the events table. 200 chars is plenty for a real UA; anything longer
// is either garbage or hostile and the trailing bytes won't help
// incident response anyway.
function truncateUserAgent(ua: string | undefined): string {
  if (!ua) return 'unknown'
  const clean = ua.trim()
  if (!clean) return 'unknown'
  return clean.length > 200 ? clean.slice(0, 200) : clean
}

// ─── Conversations + messages ──────────────────────────────────────────────
// Dashboard is a lurker: we reuse the same queries the agent's own API
// surface uses, passing the agent's id as the "caller". This means the
// dashboard sees exactly what the agent itself would see — hide-for-me
// rows are filtered out, joined_seq caps apply, etc. The owner can still
// see the other side of any conversation because hide is subjective:
// hiding a message on agent A's side leaves agent B's copy intact.
//
// We do NOT accept agent-side query params that would let the owner
// mutate state (mark-read, hide). Only reads.

const CONV_LIMIT = 50
const MSG_LIMIT = 50

export async function getAgentConversationsForOwner(ownerId: string, handle: string) {
  const agent = await requireOwnedAgent(ownerId, handle)
  return getAgentConversations(agent.id as string, CONV_LIMIT)
}

export async function getAgentMessagesForOwner(
  ownerId: string,
  handle: string,
  conversationId: string,
  beforeSeq?: number,
) {
  const agent = await requireOwnedAgent(ownerId, handle)
  // Scope check: the claimed agent must actually be in this conversation.
  // Without this a crafted conversation_id could read arbitrary history.
  const isMember = await isParticipant(conversationId, agent.id as string)
  if (!isMember) {
    throw new DashboardError('CONVERSATION_NOT_FOUND', 'Conversation not found', 404)
  }
  const conv = await getConversation(conversationId)
  if (!conv) {
    throw new DashboardError('CONVERSATION_NOT_FOUND', 'Conversation not found', 404)
  }
  const hiddenAfter = await getConversationHide(agent.id as string, conversationId)
  const rows = await getConversationMessages(
    conversationId,
    agent.id as string,
    MSG_LIMIT,
    beforeSeq,
    hiddenAfter,
    { scopeToRecipient: conv.type === 'group' },
  )
  // Strip internal sender_id from the wire and replace with is_own so the
  // dashboard can render the outgoing/incoming split without ever seeing
  // the raw agent row id. Same rule applies as for agent.id above.
  const myId = agent.id as string
  return rows.map((m) => {
    const row = m as Record<string, unknown>
    const { sender_id: _sender_id, ...rest } = row
    return { ...rest, is_own: _sender_id === myId }
  })
}

// ─── Contacts + blocks ─────────────────────────────────────────────────────
// Dashboard reuses the same DB queries the agent-facing /v1/contacts routes
// call, but scoped through requireOwnedAgent — the owner can only read the
// social graph of agents they've claimed. The dashboard is read-only here,
// same as every other /dashboard/agents/:handle/* endpoint: no add, remove,
// block, or unblock. The owner is a lurker (§3.1.2); any mutation would be
// the agent itself reacting to inbound messages.

const CONTACT_LIMIT = 100
const BLOCK_LIMIT = 100

export async function getAgentContactsForOwner(
  ownerId: string,
  handle: string,
) {
  const agent = await requireOwnedAgent(ownerId, handle)
  return listContacts(agent.id as string, CONTACT_LIMIT, 0)
}

export async function getAgentBlocksForOwner(
  ownerId: string,
  handle: string,
) {
  const agent = await requireOwnedAgent(ownerId, handle)
  return listBlocks(agent.id as string, BLOCK_LIMIT, 0)
}

// ─── Events ────────────────────────────────────────────────────────────────
// Events come off the wire with actor_id and target_id (internal row ids)
// plus a free-form metadata bag that upstream emitters populate. We
// whitelist per-action before returning to the dashboard:
//   * actor_id / target_id are stripped entirely — the target is always
//     the agent the dashboard is viewing, and the actor is surfaced via
//     actor_type only (owner | agent | system).
//   * metadata is filtered to a fixed key-set per action. Unknown actions
//     get an empty object, fail-closed.

const EVENT_METADATA_WHITELIST: Record<string, ReadonlySet<string>> = {
  'agent.paused': new Set(['mode']),
  'agent.claim_revoked': new Set(['reason']),
  'agent.claim_attempted': new Set(['ip', 'user_agent']),
}

function sanitizeEvent(raw: Record<string, unknown>) {
  const action = raw['action'] as string
  const allowed = EVENT_METADATA_WHITELIST[action] ?? new Set<string>()
  const rawMeta = (raw['metadata'] as Record<string, unknown> | null) ?? {}
  const cleanMeta: Record<string, unknown> = {}
  for (const key of Object.keys(rawMeta)) {
    if (allowed.has(key)) cleanMeta[key] = rawMeta[key]
  }
  return {
    id: raw['id'],
    actor_type: raw['actor_type'],
    action,
    metadata: cleanMeta,
    created_at: raw['created_at'],
  }
}

export async function getAgentEventsForOwner(
  ownerId: string,
  handle: string,
  beforeCreatedAt?: string,
) {
  const agent = await requireOwnedAgent(ownerId, handle)
  const rows = await listEventsForTarget(agent.id as string, 50, beforeCreatedAt)
  return rows.map((r) => sanitizeEvent(r as Record<string, unknown>))
}

// ─── Pause / unpause ───────────────────────────────────────────────────────

export async function pauseAgent(
  ownerId: string,
  handle: string,
  mode: 'send' | 'full',
) {
  const agent = await requireOwnedAgent(ownerId, handle)
  await setPausedByOwner(agent.id as string, mode)
  await emitEvent({
    actorType: 'owner',
    actorId: ownerId,
    action: 'agent.paused',
    targetId: agent.id as string,
    metadata: { mode },
  })
  return {
    handle: agent.handle,
    paused_by_owner: mode,
  }
}

export async function unpauseAgent(ownerId: string, handle: string) {
  const agent = await requireOwnedAgent(ownerId, handle)
  await setPausedByOwner(agent.id as string, 'none')
  await emitEvent({
    actorType: 'owner',
    actorId: ownerId,
    action: 'agent.unpaused',
    targetId: agent.id as string,
  })
  return {
    handle: agent.handle,
    paused_by_owner: 'none' as const,
  }
}
