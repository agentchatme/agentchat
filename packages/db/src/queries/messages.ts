import { getSupabaseClient } from '../client.js'

export async function insertMessage(message: {
  id: string
  conversation_id: string
  sender_id: string
  type: string
  content: Record<string, unknown>
  metadata?: Record<string, unknown>
  status?: string
}) {
  const { data, error } = await getSupabaseClient()
    .from('messages')
    .insert({
      ...message,
      status: message.status ?? 'stored',
    })
    .select()
    .single()

  if (error) throw error
  return data
}

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

// Status lifecycle is forward-only: stored → delivered → read
const STATUS_RANK: Record<string, number> = { stored: 0, delivered: 1, read: 2 }

export async function updateMessageStatus(
  messageId: string,
  status: 'delivered' | 'read',
) {
  const updates: Record<string, unknown> = { status }
  if (status === 'delivered') {
    updates.delivered_at = new Date().toISOString()
  } else if (status === 'read') {
    updates.read_at = new Date().toISOString()
  }

  // Only allow forward transitions — never downgrade "read" to "delivered"
  const allowedPrevious = Object.entries(STATUS_RANK)
    .filter(([, rank]) => rank < STATUS_RANK[status]!)
    .map(([name]) => name)

  const { data, error } = await getSupabaseClient()
    .from('messages')
    .update(updates)
    .eq('id', messageId)
    .in('status', allowedPrevious)
    .select()
    .single()

  if (error && error.code === 'PGRST116') {
    // No rows matched — status was already at or beyond this level. Not an error.
    const { data: existing, error: fetchError } = await getSupabaseClient()
      .from('messages')
      .select()
      .eq('id', messageId)
      .single()
    if (fetchError) throw fetchError
    return existing
  }

  if (error) throw error
  return data
}

export async function getUndeliveredMessages(agentId: string, limit = 200) {
  // Get all conversations this agent is part of
  const { data: participations, error: partError } = await getSupabaseClient()
    .from('conversation_participants')
    .select('conversation_id')
    .eq('agent_id', agentId)

  if (partError) throw partError
  if (!participations || participations.length === 0) return []

  const convIds = participations.map((p) => p.conversation_id)

  // Get oldest undelivered messages first, capped to prevent overload
  const { data, error } = await getSupabaseClient()
    .from('messages')
    .select('*')
    .in('conversation_id', convIds)
    .neq('sender_id', agentId)
    .eq('status', 'stored')
    .order('created_at', { ascending: true })
    .limit(limit)

  if (error) throw error
  return data
}

export async function deleteMessage(messageId: string, agentId: string) {
  // Only the sender can delete their own message
  const { error } = await getSupabaseClient()
    .from('messages')
    .delete()
    .eq('id', messageId)
    .eq('sender_id', agentId)

  if (error) throw error
}
