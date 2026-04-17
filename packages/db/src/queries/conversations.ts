import { getSupabaseClient } from '../client.js'
import { listMutedConversationIds, listMutedAgentIds } from './mutes.js'

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

// List conversations this agent is actively part of. Departed group members
// (left_at IS NOT NULL) are filtered out here so a left/kicked group no
// longer appears in the list — the past messages are still readable via
// the direct /v1/messages/:id endpoint for audit if the caller still has
// the conversation id, but it no longer clutters the timeline.
//
// The shape is shared between direct and group conversations. For direct
// conversations we resolve the counterparty's handle; for groups we return
// the group name/avatar and active member count instead. Clients render
// using `type` to choose which fields to show.
export async function getAgentConversations(agentId: string, limit = 50) {
  const { data, error } = await getSupabaseClient()
    .from('conversation_participants')
    .select('conversation_id')
    .eq('agent_id', agentId)
    .is('left_at', null)

  if (error) throw error
  if (!data || data.length === 0) return []

  const convIds = data.map((d) => d.conversation_id as string)

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
        .select('id, type, name, avatar_url, created_at, updated_at, last_message_at')
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

  const capped = visible.slice(0, limit)
  if (capped.length === 0) return []

  const directIds = capped.filter((c) => c.type === 'direct').map((c) => c.id as string)
  const groupIds = capped.filter((c) => c.type === 'group').map((c) => c.id as string)

  // Direct conversations: resolve the counterparty handle. For groups:
  // count active members. Run both in parallel; both are bounded by the
  // page size (default 50).
  const [directParticipantsRes, groupCountsRes] = await Promise.all([
    directIds.length === 0
      ? Promise.resolve({ data: [] as Array<{
          conversation_id: string
          agent_id: string
        }>, error: null })
      : getSupabaseClient()
          .from('conversation_participants')
          .select('conversation_id, agent_id')
          .in('conversation_id', directIds)
          .neq('agent_id', agentId)
          .is('left_at', null),
    groupIds.length === 0
      ? Promise.resolve(new Map<string, number>())
      : (async () => {
          const counts = new Map<string, number>()
          await Promise.all(
            groupIds.map(async (gid) => {
              const { count, error: cErr } = await getSupabaseClient()
                .from('conversation_participants')
                .select('*', { count: 'exact', head: true })
                .eq('conversation_id', gid)
                .is('left_at', null)
              if (cErr) throw cErr
              counts.set(gid, count ?? 0)
            }),
          )
          return counts
        })(),
  ])

  if (directParticipantsRes.error) throw directParticipantsRes.error
  const counterpartyIds = [
    ...new Set((directParticipantsRes.data ?? []).map((r) => r.agent_id as string)),
  ]
  const { data: counterpartyAgents, error: agentErr } =
    counterpartyIds.length === 0
      ? { data: [] as Array<{ id: string; handle: string; display_name: string | null }>, error: null }
      : await getSupabaseClient()
          .from('agents')
          .select('id, handle, display_name')
          .in('id', counterpartyIds)
  if (agentErr) throw agentErr
  const agentMap = new Map(
    (counterpartyAgents ?? []).map((a) => [a.id as string, a]),
  )

  // Last-message fetch per conversation. N parallel point-reads keyed
  // on the (conversation_id, seq DESC) index — same N-parallel pattern
  // we already use above for group member counts. At page size 50 this
  // is 50 fast index lookups and finishes inside one network RTT
  // window. A bulk DISTINCT ON RPC would be cleaner at much larger
  // page sizes; revisit if CONV_LIMIT ever grows past ~200.
  //
  // Preview extraction is deliberately conservative:
  //   - Only reads content.body / content.text when type === 'text'
  //   - Every other type falls back to a simple type label
  // This respects the platform-is-a-transport invariant (§4.6, "no
  // message format hints"): the dashboard reads opaque content ONLY
  // at this rendering boundary to produce a human-facing preview,
  // never to version or route the message.
  const lastMessageMap = new Map<
    string,
    { preview: string | null; is_own: boolean; type: string }
  >()
  await Promise.all(
    capped.map(async (conv) => {
      const cid = conv.id as string
      const { data: rows, error: mErr } = await getSupabaseClient()
        .from('messages')
        .select('sender_id, type, content')
        .eq('conversation_id', cid)
        .order('seq', { ascending: false })
        .limit(1)
      if (mErr) throw mErr
      const row = rows?.[0]
      if (!row) return
      lastMessageMap.set(cid, {
        preview: extractPreview(
          row.type as string,
          row.content as Record<string, unknown> | null,
        ),
        is_own: (row.sender_id as string) === agentId,
        type: row.type as string,
      })
    }),
  )

  // Map direct conv id → counterparty agent id/handle/display_name. A
  // direct conv always has exactly one other participant in Phase 1, but
  // we tolerate zero (other side purged) by leaving participants empty.
  const directParticipantMap = new Map<
    string,
    { agent_id: string; handle: string; display_name: string | null }
  >()
  for (const row of directParticipantsRes.data ?? []) {
    const agent = agentMap.get(row.agent_id as string)
    if (!agent) continue
    directParticipantMap.set(row.conversation_id as string, {
      agent_id: agent.id as string,
      handle: agent.handle as string,
      display_name: (agent.display_name as string | null) ?? null,
    })
  }

  // Mute fan-out — two batch lookups against `mutes` keyed on the calling
  // agent. Done here so the list endpoint can stamp is_muted on each row
  // without N per-row queries. Conversation-kind mutes cover both DMs and
  // groups the caller has explicitly silenced; agent-kind mutes apply to
  // the DM counterparty (group membership doesn't imply you want to mute
  // the chatty individual out of every other group too). Both calls run
  // in parallel with each other but after we've resolved the DM
  // counterparty set — we only query for counterparties that actually
  // exist in this page of conversations, keeping the IN-list small.
  const counterpartyAgentIds = [
    ...new Set(
      [...directParticipantMap.values()].map((p) => p.agent_id),
    ),
  ]
  const [mutedConvIds, mutedCounterpartyIds] = await Promise.all([
    listMutedConversationIds(agentId).catch(() => [] as string[]),
    listMutedAgentIds(agentId, counterpartyAgentIds).catch(
      () => new Set<string>(),
    ),
  ])
  const mutedConvSet = new Set(mutedConvIds)

  return capped.map((conv) => {
    const id = conv.id as string
    const type = conv.type as 'direct' | 'group'
    const lastMsg = lastMessageMap.get(id) ?? null
    if (type === 'group') {
      return {
        id,
        type,
        participants: [] as Array<{ handle: string; display_name: string | null }>,
        group_name: (conv.name as string | null) ?? null,
        group_avatar_url: (conv.avatar_url as string | null) ?? null,
        group_member_count: groupCountsRes.get(id) ?? 0,
        last_message_at: (conv.last_message_at as string | null) ?? null,
        last_message_preview: lastMsg?.preview ?? null,
        last_message_is_own: lastMsg?.is_own ?? false,
        last_message_type: lastMsg?.type ?? null,
        updated_at: conv.updated_at as string,
        is_muted: mutedConvSet.has(id),
      }
    }
    const counterparty = directParticipantMap.get(id)
    // DM is muted if the caller silenced the conversation itself OR
    // silenced the counterparty agent (mute-the-person applies across
    // every DM with them, which today is exactly one row but keeps the
    // semantics right if multi-device DMs ever land).
    const isMuted =
      mutedConvSet.has(id) ||
      (counterparty !== undefined && mutedCounterpartyIds.has(counterparty.agent_id))
    return {
      id,
      type,
      participants: counterparty
        ? [{ handle: counterparty.handle, display_name: counterparty.display_name }]
        : [],
      group_name: null,
      group_avatar_url: null,
      group_member_count: null,
      last_message_at: (conv.last_message_at as string | null) ?? null,
      last_message_preview: lastMsg?.preview ?? null,
      last_message_is_own: lastMsg?.is_own ?? false,
      last_message_type: lastMsg?.type ?? null,
      updated_at: conv.updated_at as string,
      is_muted: isMuted,
    }
  })
}

// Compact one-line preview for the conversation list. Conservative by
// design: only peeks inside content for type === 'text'. Everything
// else returns a human-readable type label so the row renders
// something useful without assuming a schema that isn't ours to
// define (§4.6 no-format-hints rule).
const PREVIEW_MAX_LEN = 140
function extractPreview(
  type: string,
  content: Record<string, unknown> | null,
): string | null {
  if (type === 'text' && content) {
    const body = content['body']
    const text = content['text']
    const raw = typeof body === 'string' ? body : typeof text === 'string' ? text : null
    if (!raw) return null
    const collapsed = raw.replace(/\s+/g, ' ').trim()
    if (collapsed.length === 0) return null
    return collapsed.length > PREVIEW_MAX_LEN
      ? collapsed.slice(0, PREVIEW_MAX_LEN - 1) + '…'
      : collapsed
  }
  if (type === 'image') return 'Photo'
  if (type === 'file' || type === 'attachment') return 'Attachment'
  if (type === 'system') return 'System update'
  return `[${type}]`
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

// Active participation only. A departed group member is no longer a
// participant for authorization purposes: they can't send, read new
// messages, or see the conversation in their list. Their past messages
// remain in place (soft-remove via left_at).
export async function isParticipant(conversationId: string, agentId: string): Promise<boolean> {
  const { data } = await getSupabaseClient()
    .from('conversation_participants')
    .select('agent_id, left_at')
    .eq('conversation_id', conversationId)
    .eq('agent_id', agentId)
    .maybeSingle()

  if (!data) return false
  return data.left_at === null
}

export async function getConversationParticipants(conversationId: string) {
  const { data, error } = await getSupabaseClient()
    .from('conversation_participants')
    .select('agent_id')
    .eq('conversation_id', conversationId)
    .is('left_at', null)

  if (error) throw error
  if (!data || data.length === 0) return []

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

/**
 * Like getConversation but returns null on "no rows" instead of throwing,
 * and still surfaces real errors (network, permissions). Use this when
 * the caller needs to DISTINGUISH a missing row from an infrastructure
 * failure — e.g. a service-layer existence check that must map missing
 * to 404 and everything else to 500. getConversation collapses both into
 * a thrown error, which is fine for internal call sites but wrong for
 * input-validation paths.
 */
export async function findConversationById(conversationId: string) {
  const { data, error } = await getSupabaseClient()
    .from('conversations')
    .select('*')
    .eq('id', conversationId)
    .maybeSingle()
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
