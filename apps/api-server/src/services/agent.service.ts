import { randomBytes, createHash } from 'node:crypto'
import { getSupabaseClient, findAgentById, findAgentByHandle, rotateApiKeyAtomic } from '@agentchat/db'
import { AgentSettings, type UpdateAgentRequest } from '@agentchat/shared'
import { publishDisconnect } from '../ws/pubsub.js'
import { generateId } from '../lib/id.js'
import { buildAvatarUrl } from './avatar.service.js'

export class AgentError extends Error {
  code: string
  status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'AgentError'
    this.code = code
    this.status = status
  }
}

/**
 * Check if a handle is available for registration.
 * Unlike findAgentByHandle (which filters by active status),
 * this checks ALL agents including soft-deleted ones — because the DB
 * UNIQUE constraint on handle is unfiltered.
 */
export async function isHandleAvailable(handle: string): Promise<boolean> {
  const { data } = await getSupabaseClient()
    .from('agents')
    .select('id')
    .eq('handle', handle)
    .limit(1)
    .maybeSingle()
  return data === null
}

export async function getAgent(handle: string) {
  const agent = await findAgentByHandle(handle)

  if (!agent || agent.status === 'deleted') {
    throw new AgentError('AGENT_NOT_FOUND', `Account @${handle} not found`, 404)
  }

  return {
    handle: agent.handle,
    display_name: agent.display_name,
    description: agent.description,
    avatar_url: buildAvatarUrl(agent.avatar_key as string | null),
    status: agent.status,
    created_at: agent.created_at,
  }
}

export async function updateAgent(id: string, req: UpdateAgentRequest, agentId: string) {
  if (id !== agentId) {
    throw new AgentError('FORBIDDEN', 'You can only update your own account', 403)
  }

  const agent = await findAgentById(id)
  if (!agent || agent.status === 'deleted') {
    throw new AgentError('AGENT_NOT_FOUND', 'Account not found', 404)
  }
  if (agent.status === 'suspended') {
    throw new AgentError('FORBIDDEN', 'Cannot update a suspended account', 403)
  }

  const updates: Record<string, unknown> = {}
  if (req.display_name !== undefined) updates.display_name = req.display_name
  if (req.description !== undefined) updates.description = req.description
  if (req.settings !== undefined) {
    updates.settings = { ...agent.settings, ...req.settings }
  }

  // Normalizing helper: materialize the full settings shape (with defaults
  // for fields that were never persisted on older rows) so the PATCH
  // response matches what GET /me returns. A Zod parse is cheaper than
  // an extra DB round-trip and mirrors the /me normalization step.
  //
  // Also translates the internal `avatar_key` storage column into the
  // wire-format `avatar_url` (public CDN URL), so every caller of this
  // route sees the same shape on update as on read. Keeping the transform
  // here means route handlers don't each have to remember it.
  const withWireShape = <T extends { settings?: unknown; avatar_key?: unknown }>(
    row: T,
  ): Omit<T, 'avatar_key'> & { settings: AgentSettings; avatar_url: string | null } => {
    const { avatar_key, ...rest } = row
    return {
      ...rest,
      settings: AgentSettings.parse(row.settings ?? {}),
      avatar_url: buildAvatarUrl((avatar_key as string | null | undefined) ?? null),
    }
  }

  // No fields to update — return current state
  if (Object.keys(updates).length === 0) {
    const { api_key_hash: _, id: _id, email: _email, ...safeData } = agent
    return withWireShape(safeData)
  }

  const { data, error } = await getSupabaseClient()
    .from('agents')
    .update(updates)
    .eq('id', id)
    .select()
    .single()

  if (error) throw error
  const { api_key_hash: _, id: _id, email: _email, ...safeData } = data
  return withWireShape(safeData)
}

export async function deleteAgent(id: string, agentId: string) {
  if (id !== agentId) {
    throw new AgentError('FORBIDDEN', 'You can only delete your own account', 403)
  }

  const agent = await findAgentById(id)
  if (!agent || agent.status === 'deleted') {
    throw new AgentError('AGENT_NOT_FOUND', 'Account not found', 404)
  }

  const { error } = await getSupabaseClient()
    .from('agents')
    .update({ status: 'deleted' })
    .eq('id', id)

  if (error) throw error

  // Evict any live WS sessions across every server. The socket was
  // authenticated with credentials that no longer map to a valid account.
  publishDisconnect(id, 1008, 'Account deleted')
}

export async function rotateApiKey(id: string, agentId: string) {
  if (id !== agentId) {
    throw new AgentError('FORBIDDEN', 'You can only rotate your own API key', 403)
  }

  const agent = await findAgentById(id)
  if (!agent || agent.status === 'deleted') {
    throw new AgentError('AGENT_NOT_FOUND', 'Account not found', 404)
  }

  const newApiKey = `ac_${randomBytes(32).toString('base64url')}`
  const newHash = createHash('sha256').update(newApiKey).digest('hex')

  // Atomic: UPDATE api_key_hash + DELETE any dashboard claim + emit
  // agent.key_rotated (+ agent.claim_revoked if a claim existed).
  // Ensures a leaked key that gets rotated cannot leave a stale dashboard
  // claim behind. Event IDs are pre-generated so the RPC stays
  // deterministic and the caller could log them if needed.
  await rotateApiKeyAtomic({
    agent_id: id,
    new_hash: newHash,
    rotated_event_id: generateId('evt'),
    revoked_event_id: generateId('evt'),
  })

  // Evict any live WS sessions across every server. A socket that was
  // authenticated with the old key is no longer a valid session — the
  // client must reconnect with the new credential.
  publishDisconnect(id, 1008, 'API key rotated')

  return { handle: agent.handle, api_key: newApiKey }
}
