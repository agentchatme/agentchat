import { getSupabaseClient } from '../client.js'

export async function findDirectConversation(agentA: string, agentB: string) {
  const { data, error } = await getSupabaseClient()
    .rpc('find_direct_conversation', { agent_a: agentA, agent_b: agentB })
  if (error) return null
  return data
}

export async function getAgentConversations(agentId: string, limit = 50) {
  const { data, error } = await getSupabaseClient()
    .from('conversation_participants')
    .select('conversation_id, conversations(*)')
    .eq('agent_id', agentId)
    .order('conversations(last_message_at)', { ascending: false })
    .limit(limit)
  if (error) throw error
  return data
}
