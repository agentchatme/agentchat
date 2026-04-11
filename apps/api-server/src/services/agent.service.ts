import { randomBytes, createHash } from 'node:crypto'
import { getSupabaseClient, findAgentById, findAgentByHandle } from '@agentchat/db'
import type { UpdateAgentRequest } from '@agentchat/shared'

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

  // No fields to update — return current state
  if (Object.keys(updates).length === 0) {
    const { api_key_hash: _, id: _id, email: _email, ...safeData } = agent
    return safeData
  }

  const { data, error } = await getSupabaseClient()
    .from('agents')
    .update(updates)
    .eq('id', id)
    .select()
    .single()

  if (error) throw error
  const { api_key_hash: _, id: _id, email: _email, ...safeData } = data
  return safeData
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

  const { error } = await getSupabaseClient()
    .from('agents')
    .update({ api_key_hash: newHash })
    .eq('id', id)

  if (error) throw error

  return { handle: agent.handle, api_key: newApiKey }
}
