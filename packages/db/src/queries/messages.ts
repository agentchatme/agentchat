import { getSupabaseClient } from '../client.js'

/**
 * Atomic idempotent message insert. Calls the SQL function
 * send_message_atomic which:
 *   1. Fast-paths on (sender_id, client_msg_id) — returns the existing row
 *      with is_replay=true if this exact send has already happened.
 *   2. Atomically bumps conversations.next_seq and assigns the message seq.
 *   3. Recovers from the concurrent-insert race via a unique_violation catch.
 *
 * Return value includes `is_replay` so the route can map to 200 (replay) vs
 * 201 (new) and callers can skip the push fan-out on replays.
 */
export async function atomicSendMessage(params: {
  id: string
  conversation_id: string
  sender_id: string
  client_msg_id: string
  type: string
  content: Record<string, unknown>
  metadata?: Record<string, unknown>
}) {
  const { data, error } = await getSupabaseClient().rpc('send_message_atomic', {
    p_message_id: params.id,
    p_conversation_id: params.conversation_id,
    p_sender_id: params.sender_id,
    p_client_msg_id: params.client_msg_id,
    p_type: params.type,
    p_content: params.content,
    p_metadata: params.metadata ?? {},
  })

  if (error) throw error

  const row = Array.isArray(data) ? data[0] : data
  if (!row) throw new Error('send_message_atomic returned no row')
  return row as {
    id: string
    conversation_id: string
    sender_id: string
    client_msg_id: string
    seq: number
    type: string
    content: Record<string, unknown>
    metadata: Record<string, unknown>
    status: string
    created_at: string
    delivered_at: string | null
    read_at: string | null
    is_replay: boolean
  }
}

export async function getConversationMessages(
  conversationId: string,
  limit = 50,
  beforeSeq?: number,
) {
  let query = getSupabaseClient()
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('seq', { ascending: false })
    .limit(limit)

  if (beforeSeq !== undefined) {
    query = query.lt('seq', beforeSeq)
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

export async function deleteMessage(messageId: string, agentId: string): Promise<boolean> {
  // Only the sender can delete their own message
  const { data, error } = await getSupabaseClient()
    .from('messages')
    .delete()
    .eq('id', messageId)
    .eq('sender_id', agentId)
    .select('id')

  if (error) throw error
  return (data?.length ?? 0) > 0
}
