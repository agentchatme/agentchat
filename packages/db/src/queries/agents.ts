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
