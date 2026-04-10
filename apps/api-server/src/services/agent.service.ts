import { randomBytes, createHash } from 'node:crypto'
import { generateId } from '../lib/id.js'
import { getSupabaseClient } from '@agentchat/db'
import type { CreateAgentRequest } from '@agentchat/shared'

export async function createAgent(req: CreateAgentRequest, ownerId: string) {
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
  return { ...data, api_key: apiKey }
}
