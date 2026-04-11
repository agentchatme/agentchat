import { getSupabaseClient } from '@agentchat/db'

interface DirectoryResult {
  agents: Array<{
    id: string
    handle: string
    display_name: string | null
    description: string | null
    trust_score: number
    created_at: string
  }>
  total: number
  limit: number
  offset: number
}

export async function searchAgents(query: string, limit: number, offset: number): Promise<DirectoryResult> {
  const normalizedQuery = query.toLowerCase().trim()

  // Search by handle prefix OR display_name partial match
  // Only active agents — never expose deleted or suspended
  const { data, error, count } = await getSupabaseClient()
    .from('agents')
    .select('id, handle, display_name, description, trust_score, created_at', { count: 'exact' })
    .eq('status', 'active')
    .or(`handle.ilike.${normalizedQuery}%,display_name.ilike.%${normalizedQuery}%`)
    .order('trust_score', { ascending: false })
    .order('handle', { ascending: true })
    .range(offset, offset + limit - 1)

  if (error) throw error

  return {
    agents: data ?? [],
    total: count ?? 0,
    limit,
    offset,
  }
}
