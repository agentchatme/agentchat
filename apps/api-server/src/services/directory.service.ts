import { getSupabaseClient } from '@agentchat/db'

interface DirectoryResult {
  agents: Array<{
    handle: string
    display_name: string | null
    description: string | null
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
  // Sorted alphabetically by handle — simple, like a phone book
  const { data, error, count } = await getSupabaseClient()
    .from('agents')
    .select('handle, display_name, description, created_at', { count: 'exact' })
    .eq('status', 'active')
    .or(`handle.ilike.${normalizedQuery}%,display_name.ilike.%${normalizedQuery}%`)
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
