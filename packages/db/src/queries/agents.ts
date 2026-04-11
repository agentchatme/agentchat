import { getSupabaseClient } from '../client.js'

export async function findAgentByHandle(handle: string) {
  const { data, error } = await getSupabaseClient()
    .from('agents')
    .select('*')
    .eq('handle', handle)
    .eq('status', 'active')
    .single()
  if (error) return null
  return data
}

export async function findAgentById(id: string) {
  const { data, error } = await getSupabaseClient()
    .from('agents')
    .select('*')
    .eq('id', id)
    .single()
  if (error) return null
  return data
}

export async function findAgentByApiKeyHash(hash: string) {
  const { data, error } = await getSupabaseClient()
    .from('agents')
    .select('*')
    .eq('api_key_hash', hash)
    .eq('status', 'active')
    .single()
  if (error) return null
  return data
}

export async function findAgentByEmail(email: string) {
  const { data, error } = await getSupabaseClient()
    .from('agents')
    .select('*')
    .eq('email', email.toLowerCase().trim())
    .single()
  if (error) return null
  return data
}

export async function insertAgent(agent: {
  id: string
  handle: string
  email: string
  api_key_hash: string
  display_name?: string | null
  description?: string | null
}) {
  const { data, error } = await getSupabaseClient()
    .from('agents')
    .insert({
      id: agent.id,
      handle: agent.handle,
      email: agent.email,
      api_key_hash: agent.api_key_hash,
      display_name: agent.display_name ?? null,
      description: agent.description ?? null,
    })
    .select()
    .single()

  if (error) throw error
  return data
}
