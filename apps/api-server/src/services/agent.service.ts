import { randomBytes, createHash } from 'node:crypto'
import { generateId } from '../lib/id.js'
import { getSupabaseClient, findAgentById, findAgentByHandle } from '@agentchat/db'
import { isValidHandle } from '@agentchat/shared'
import type { CreateAgentRequest, UpdateAgentRequest } from '@agentchat/shared'

export async function createAgent(req: CreateAgentRequest, ownerId: string) {
  if (!isValidHandle(req.handle)) {
    throw new AgentError('INVALID_HANDLE', 'Handle contains invalid characters or is reserved', 400)
  }

  // Check if handle is taken
  const existing = await findAgentByHandle(req.handle)
  if (existing) {
    throw new AgentError('HANDLE_TAKEN', `Handle @${req.handle} is already taken`, 409)
  }

  const id = generateId('agt')
  const apiKey = `ac_${randomBytes(32).toString('base64url')}`
  const apiKeyHash = createHash('sha256').update(apiKey).digest('hex')

  const { data, error } = await getSupabaseClient()
    .from('agents')
    .insert({
      id,
      handle: req.handle,
      display_name: req.display_name ?? null,
      description: req.description ?? null,
      owner_id: ownerId,
      api_key_hash: apiKeyHash,
    })
    .select()
    .single()

  if (error) throw error
  // Return agent with raw API key — shown only once
  return { ...data, api_key: apiKey }
}

export async function getAgent(idOrHandle: string) {
  // If it starts with agt_, look up by ID. Otherwise by handle.
  const agent = idOrHandle.startsWith('agt_')
    ? await findAgentById(idOrHandle)
    : await findAgentByHandle(idOrHandle)

  if (!agent) {
    throw new AgentError('AGENT_NOT_FOUND', `Agent ${idOrHandle} not found`, 404)
  }

  // Return public profile only — no api_key_hash, no owner_id
  return {
    id: agent.id,
    handle: agent.handle,
    display_name: agent.display_name,
    description: agent.description,
    status: agent.status,
    trust_score: agent.trust_score,
    created_at: agent.created_at,
  }
}

export async function updateAgent(id: string, req: UpdateAgentRequest, ownerId: string) {
  // Verify ownership
  const agent = await findAgentById(id)
  if (!agent) {
    throw new AgentError('AGENT_NOT_FOUND', `Agent ${id} not found`, 404)
  }
  if (agent.owner_id !== ownerId) {
    throw new AgentError('FORBIDDEN', 'You do not own this agent', 403)
  }

  const updates: Record<string, unknown> = {}
  if (req.display_name !== undefined) updates.display_name = req.display_name
  if (req.description !== undefined) updates.description = req.description
  if (req.settings !== undefined) {
    updates.settings = { ...agent.settings, ...req.settings }
  }

  const { data, error } = await getSupabaseClient()
    .from('agents')
    .update(updates)
    .eq('id', id)
    .select()
    .single()

  if (error) throw error
  return data
}

export async function deleteAgent(id: string, ownerId: string) {
  const agent = await findAgentById(id)
  if (!agent) {
    throw new AgentError('AGENT_NOT_FOUND', `Agent ${id} not found`, 404)
  }
  if (agent.owner_id !== ownerId) {
    throw new AgentError('FORBIDDEN', 'You do not own this agent', 403)
  }

  // Soft delete
  const { error } = await getSupabaseClient()
    .from('agents')
    .update({ status: 'deleted' })
    .eq('id', id)

  if (error) throw error
}

export async function listOwnerAgents(ownerId: string) {
  const { data, error } = await getSupabaseClient()
    .from('agents')
    .select('*')
    .eq('owner_id', ownerId)
    .neq('status', 'deleted')
    .order('created_at', { ascending: false })

  if (error) throw error
  return data
}

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
