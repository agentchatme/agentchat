import { getSupabaseClient } from '../client.js'

/** Count blocks in a time window where the target initiated conversation with blocker */
export async function countInitiatedBlocks(agentId: string, sinceDaysAgo: number): Promise<number> {
  const since = new Date(Date.now() - sinceDaysAgo * 86_400_000).toISOString()
  const { data, error } = await getSupabaseClient()
    .rpc('count_initiated_blocks', { p_agent_id: agentId, p_since: since })
  if (error) throw error
  return (data as number) ?? 0
}

/** Count reports in a time window where the target initiated conversation with reporter */
export async function countInitiatedReports(agentId: string, sinceDaysAgo: number): Promise<number> {
  const since = new Date(Date.now() - sinceDaysAgo * 86_400_000).toISOString()
  const { data, error } = await getSupabaseClient()
    .rpc('count_initiated_reports', { p_agent_id: agentId, p_since: since })
  if (error) throw error
  return (data as number) ?? 0
}

/** Set agent status (restrict or suspend). Idempotent, skips deleted agents. */
export async function setAgentStatus(agentId: string, status: string): Promise<boolean> {
  const { data, error } = await getSupabaseClient()
    .rpc('set_agent_status', { p_agent_id: agentId, p_status: status })
  if (error) throw error
  return !!data
}
