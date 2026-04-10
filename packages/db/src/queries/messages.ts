import { getSupabaseClient } from '../client.js'

export async function getConversationMessages(
  conversationId: string,
  limit = 50,
  before?: string,
) {
  let query = getSupabaseClient()
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (before) {
    query = query.lt('created_at', before)
  }

  const { data, error } = await query
  if (error) throw error
  return data
}

export async function insertMessage(message: {
  id: string
  conversation_id: string
  sender_id: string
  type: string
  content: Record<string, unknown>
  metadata?: Record<string, unknown>
}) {
  const { data, error } = await getSupabaseClient()
    .from('messages')
    .insert(message)
    .select()
    .single()
  if (error) throw error
  return data
}
