import { getSupabaseClient } from '../client.js'

export async function getBlockCount(agentId: string, sinceDaysAgo = 30) {
  const since = new Date(Date.now() - sinceDaysAgo * 86400000).toISOString()
  const { count, error } = await getSupabaseClient()
    .from('blocks')
    .select('*', { count: 'exact', head: true })
    .eq('blocked_id', agentId)
    .gte('created_at', since)
  if (error) throw error
  return count ?? 0
}

export async function getReportCount(agentId: string, sinceDaysAgo = 30) {
  const since = new Date(Date.now() - sinceDaysAgo * 86400000).toISOString()
  const { count, error } = await getSupabaseClient()
    .from('reports')
    .select('*', { count: 'exact', head: true })
    .eq('reported_id', agentId)
    .gte('created_at', since)
  if (error) throw error
  return count ?? 0
}
