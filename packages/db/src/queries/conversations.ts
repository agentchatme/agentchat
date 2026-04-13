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

  // Load this agent's hide rows in parallel with the conversation fetch.
  // A conversation is hidden for this agent iff there's a hide row AND
  // conversations.last_message_at <= hidden_at (i.e. nothing new has
  // landed since the hide). Filtering in-app instead of in SQL keeps the
  // PostgREST surface simple and is cheap: the hide set is small (agents
  // who clean up regularly still tend to hide < 100 chats).
  const [{ data: conversations, error: convError }, { data: hides, error: hideErr }] =
    await Promise.all([
      getSupabaseClient()
        .from('conversations')
        .select('id, type, created_at, updated_at, last_message_at')
        .in('id', convIds)
        .order('last_message_at', { ascending: false, nullsFirst: false }),
      getSupabaseClient()
        .from('conversation_hides')
        .select('conversation_id, hidden_at')
        .eq('agent_id', agentId)
        .in('conversation_id', convIds),
    ])

  if (convError) throw convError
  if (hideErr) throw hideErr
  if (!conversations) return []

  const hideMap = new Map<string, string>(
    (hides ?? []).map((h) => [h.conversation_id as string, h.hidden_at as string]),
  )

  const visible = conversations.filter((conv) => {
    const hiddenAt = hideMap.get(conv.id as string)
    if (!hiddenAt) return true
    const last = conv.last_message_at as string | null
    // No last message yet? The hide still masks the bare conversation.
    if (!last) return false
    // A message arrived strictly after the hide → conversation resurfaces.
    return last > hiddenAt
  })

  return visible.slice(0, limit)
}

/**
 * Upsert a hide row for (agentId, conversationId) with hidden_at = NOW().
 * Re-hiding an already-visible (or already-hidden) conversation is a no-op
 * in terms of row count but advances hidden_at so the conversation is
 * hidden again even if a new message arrived since the last hide.
 */
export async function hideConversationForAgent(
  agentId: string,
  conversationId: string,
): Promise<void> {
  const { error } = await getSupabaseClient()
    .from('conversation_hides')
    .upsert(
      {
        agent_id: agentId,
        conversation_id: conversationId,
        hidden_at: new Date().toISOString(),
      },
      { onConflict: 'agent_id,conversation_id' },
    )
  if (error) throw error
}

/**
 * Look up this agent's hide timestamp for a given conversation. Returns
 * null if the agent has not hidden it. Used by the message-history query
 * to filter out messages that landed at or before the hide.
 */
export async function getConversationHide(
  agentId: string,
  conversationId: string,
): Promise<string | null> {
  const { data, error } = await getSupabaseClient()
    .from('conversation_hides')
    .select('hidden_at')
    .eq('agent_id', agentId)
    .eq('conversation_id', conversationId)
    .maybeSingle()

  if (error) throw error
  return (data?.hidden_at as string | undefined) ?? null
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

export async function getConversationParticipants(conversationId: string) {
  const { data, error } = await getSupabaseClient()
    .from('conversation_participants')
    .select('agent_id')
    .eq('conversation_id', conversationId)

  if (error) throw error
  if (!data || data.length === 0) return []

  // Resolve agent IDs to handles
  const agentIds = data.map((d) => d.agent_id)
  const { data: agents, error: agentError } = await getSupabaseClient()
    .from('agents')
    .select('id, handle, display_name')
    .in('id', agentIds)

  if (agentError) throw agentError

  const agentMap = new Map((agents ?? []).map((a) => [a.id, a]))
  return data
    .filter((d) => agentMap.has(d.agent_id))
    .map((d) => {
      const agent = agentMap.get(d.agent_id)!
      return { handle: agent.handle, display_name: agent.display_name }
    })
}

export async function countColdOutreaches(agentId: string, since: string): Promise<number> {
  const { data, error } = await getSupabaseClient()
    .rpc('count_cold_outreaches', {
      p_agent_id: agentId,
      p_since: since,
    })

  if (error) throw error
  return (data as number) ?? 0
}

export async function getConversation(conversationId: string) {
  const { data, error } = await getSupabaseClient()
    .from('conversations')
    .select('*')
    .eq('id', conversationId)
    .single()

  if (error) throw error
  return data
}

export async function markConversationEstablished(conversationId: string) {
  const { error } = await getSupabaseClient()
    .from('conversations')
    .update({ established: true })
    .eq('id', conversationId)

  if (error) throw error
}
