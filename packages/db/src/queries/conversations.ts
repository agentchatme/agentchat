import { getSupabaseClient } from '../client.js'

export async function findDirectConversation(agentA: string, agentB: string): Promise<string | null> {
  const { data, error } = await getSupabaseClient()
    .rpc('find_direct_conversation', { agent_a: agentA, agent_b: agentB })
  if (error || !data) return null
  return data as string
}

export async function findOrCreateDirectConversation(
  agentA: string,
  agentB: string,
  newConversationId: string,
): Promise<{ conversationId: string; isNew: boolean }> {
  const { data, error } = await getSupabaseClient()
    .rpc('find_or_create_direct_conversation', {
      p_agent_a: agentA,
      p_agent_b: agentB,
      p_conv_id: newConversationId,
    })

  if (error) throw error

  const row = Array.isArray(data) ? data[0] : data
  return {
    conversationId: row.conversation_id,
    isNew: row.is_new,
  }
}

export async function getAgentConversations(agentId: string, limit = 50) {
  const { data, error } = await getSupabaseClient()
    .from('conversation_participants')
    .select('conversation_id')
    .eq('agent_id', agentId)

  if (error) throw error
  if (!data || data.length === 0) return []

  const convIds = data.map((d) => d.conversation_id)

  const { data: conversations, error: convError } = await getSupabaseClient()
    .from('conversations')
    .select('*')
    .in('id', convIds)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(limit)

  if (convError) throw convError
  return conversations
}

export async function updateConversationLastMessage(conversationId: string) {
  const { error } = await getSupabaseClient()
    .from('conversations')
    .update({ last_message_at: new Date().toISOString() })
    .eq('id', conversationId)

  if (error) throw error
}

export async function isParticipant(conversationId: string, agentId: string): Promise<boolean> {
  const { data } = await getSupabaseClient()
    .from('conversation_participants')
    .select('agent_id')
    .eq('conversation_id', conversationId)
    .eq('agent_id', agentId)
    .single()

  return !!data
}

export async function getConversationParticipants(conversationId: string): Promise<string[]> {
  const { data, error } = await getSupabaseClient()
    .from('conversation_participants')
    .select('agent_id')
    .eq('conversation_id', conversationId)

  if (error) throw error
  return (data ?? []).map((d) => d.agent_id)
}
