import { getSupabaseClient } from '../client.js'

// All group membership mutations go through atomic plpgsql RPCs
// (see migration 017). The wrappers here exist to give the service layer
// a typed shape and to centralize error translation. They deliberately do
// NOT enforce permissions or emit events — that's the service layer's job.

export async function createGroup(params: {
  id: string
  creator_id: string
  name: string
  description: string | null
  avatar_url: string | null
  settings: Record<string, unknown>
}): Promise<string> {
  const { data, error } = await getSupabaseClient().rpc('create_group_atomic', {
    p_group_id: params.id,
    p_creator_id: params.creator_id,
    p_name: params.name,
    p_description: params.description,
    p_avatar_url: params.avatar_url,
    p_settings: params.settings,
  })
  if (error) throw error
  return data as string
}

export interface AddMemberOutcome {
  status: 'joined' | 'rejoined' | 'already_member'
  joined_seq: number
}

export async function addGroupMember(
  groupId: string,
  agentId: string,
  maxSize: number,
): Promise<AddMemberOutcome> {
  const { data, error } = await getSupabaseClient().rpc('add_member_atomic', {
    p_group_id: groupId,
    p_agent_id: agentId,
    p_max_size: maxSize,
  })
  if (error) throw error
  const row = Array.isArray(data) ? data[0] : data
  return {
    status: row.status as AddMemberOutcome['status'],
    joined_seq: Number(row.joined_seq),
  }
}

export interface AcceptInviteOutcome {
  conversation_id: string
  status: 'joined' | 'rejoined' | 'already_member'
  joined_seq: number
}

export async function acceptGroupInvite(
  inviteId: string,
  agentId: string,
  maxSize: number,
): Promise<AcceptInviteOutcome> {
  const { data, error } = await getSupabaseClient().rpc('accept_invite_atomic', {
    p_invite_id: inviteId,
    p_agent_id: agentId,
    p_max_size: maxSize,
  })
  if (error) throw error
  const row = Array.isArray(data) ? data[0] : data
  return {
    conversation_id: row.conversation_id as string,
    status: row.status as AcceptInviteOutcome['status'],
    joined_seq: Number(row.joined_seq),
  }
}

export interface LeaveOutcome {
  was_member: boolean
  promoted_agent_id: string | null
}

export async function leaveGroup(
  groupId: string,
  agentId: string,
): Promise<LeaveOutcome> {
  const { data, error } = await getSupabaseClient().rpc('leave_group_atomic', {
    p_group_id: groupId,
    p_agent_id: agentId,
  })
  if (error) throw error
  const row = Array.isArray(data) ? data[0] : data
  return {
    was_member: row.was_member as boolean,
    promoted_agent_id: (row.promoted_agent_id as string | null) ?? null,
  }
}

export async function kickGroupMember(
  groupId: string,
  targetId: string,
): Promise<boolean> {
  const { data, error } = await getSupabaseClient().rpc('kick_member_atomic', {
    p_group_id: groupId,
    p_target_id: targetId,
  })
  if (error) throw error
  const row = Array.isArray(data) ? data[0] : data
  return row.was_member as boolean
}

export async function promoteGroupAdmin(
  groupId: string,
  targetId: string,
): Promise<boolean> {
  const { data, error } = await getSupabaseClient().rpc('promote_to_admin_atomic', {
    p_group_id: groupId,
    p_target_id: targetId,
  })
  if (error) throw error
  return Boolean(data)
}

export type DemoteResult = 'ok' | 'not_admin' | 'last_admin' | 'creator' | 'not_found'

export async function demoteGroupAdmin(
  groupId: string,
  targetId: string,
): Promise<DemoteResult> {
  const { data, error } = await getSupabaseClient().rpc('demote_admin_atomic', {
    p_group_id: groupId,
    p_target_id: targetId,
  })
  if (error) throw error
  return data as DemoteResult
}

export async function getGroupMemberCount(groupId: string): Promise<number> {
  const { data, error } = await getSupabaseClient().rpc('group_member_count', {
    p_group_id: groupId,
  })
  if (error) throw error
  return (data as number) ?? 0
}

// Read a single group row — includes the metadata columns we added in 017.
// Returns null if the conversation doesn't exist OR isn't a group.
export async function findGroupById(groupId: string) {
  const { data, error } = await getSupabaseClient()
    .from('conversations')
    .select('*')
    .eq('id', groupId)
    .eq('type', 'group')
    .maybeSingle()
  if (error) throw error
  return data
}

export async function getGroupParticipantRole(
  groupId: string,
  agentId: string,
): Promise<'admin' | 'member' | null> {
  const { data, error } = await getSupabaseClient()
    .from('conversation_participants')
    .select('role, left_at')
    .eq('conversation_id', groupId)
    .eq('agent_id', agentId)
    .maybeSingle()
  if (error) throw error
  if (!data || data.left_at !== null) return null
  return data.role as 'admin' | 'member'
}

// Returns the caller's join-time seq so downstream reads can filter out
// messages from before they joined. Null if not an active participant.
export async function getGroupParticipantJoinedSeq(
  groupId: string,
  agentId: string,
): Promise<number | null> {
  const { data, error } = await getSupabaseClient()
    .from('conversation_participants')
    .select('joined_seq, left_at')
    .eq('conversation_id', groupId)
    .eq('agent_id', agentId)
    .maybeSingle()
  if (error) throw error
  if (!data || data.left_at !== null) return null
  return (data.joined_seq as number | null) ?? 0
}

// Agent ids of members who should receive the ephemeral push (WS +
// webhook) for a group message at `maxSeq`. Runs in one round-trip and
// pre-filters to exactly the set that would see the message in history:
//
//   - Active members only (left_at IS NULL) — departed members had their
//     envelopes flushed to 'delivered' on leave/kick, and the ephemeral
//     push should match that.
//   - joined_seq <= maxSeq — excludes members who joined AFTER this
//     message's seq was allocated. Their history filter
//     (`seq >= joined_seq`) would hide the message anyway, and without
//     this cap a just-joined client would get a `message.new` event for
//     a message it can neither refetch nor find in /sync. Consistent
//     with the no-pre-join-leakage invariant from migration 017.
//   - Sender is excluded so the caller doesn't echo its own write.
export async function getGroupPushRecipients(
  groupId: string,
  maxSeq: number,
  excludeAgentId: string,
): Promise<string[]> {
  const { data, error } = await getSupabaseClient()
    .from('conversation_participants')
    .select('agent_id')
    .eq('conversation_id', groupId)
    .is('left_at', null)
    .lte('joined_seq', maxSeq)
    .neq('agent_id', excludeAgentId)
  if (error) throw error
  return (data ?? []).map((d) => d.agent_id as string)
}

// Active members only (left_at IS NULL). Joined with agents for handle
// and display_name. Ordered by joined_at so the creator tends to come
// first (tie-broken by agent_id for determinism under identical timestamps).
export async function getGroupMembers(groupId: string) {
  const { data, error } = await getSupabaseClient()
    .from('conversation_participants')
    .select('agent_id, role, joined_at')
    .eq('conversation_id', groupId)
    .is('left_at', null)
    .order('joined_at', { ascending: true })
    .order('agent_id', { ascending: true })

  if (error) throw error
  if (!data || data.length === 0) return []

  const agentIds = data.map((d) => d.agent_id as string)
  const { data: agents, error: agentErr } = await getSupabaseClient()
    .from('agents')
    .select('id, handle, display_name')
    .in('id', agentIds)
  if (agentErr) throw agentErr

  const agentMap = new Map((agents ?? []).map((a) => [a.id, a]))
  return data
    .filter((d) => agentMap.has(d.agent_id as string))
    .map((d) => {
      const agent = agentMap.get(d.agent_id as string)!
      return {
        handle: agent.handle as string,
        display_name: (agent.display_name as string | null) ?? null,
        role: d.role as 'admin' | 'member',
        joined_at: d.joined_at as string,
      }
    })
}

// --- Group invitations ---

export async function createGroupInvitation(params: {
  id: string
  conversation_id: string
  invitee_id: string
  inviter_id: string
}): Promise<{ created: boolean; invite_id: string }> {
  // Idempotent: UNIQUE (conversation_id, invitee_id) means a second invite
  // to the same target returns the existing row instead of a duplicate.
  const { data, error } = await getSupabaseClient()
    .from('group_invitations')
    .upsert(
      {
        id: params.id,
        conversation_id: params.conversation_id,
        invitee_id: params.invitee_id,
        inviter_id: params.inviter_id,
      },
      { onConflict: 'conversation_id,invitee_id', ignoreDuplicates: false },
    )
    .select('id')
    .single()

  if (error) throw error
  return { created: data.id === params.id, invite_id: data.id as string }
}

export async function findGroupInvitation(inviteId: string) {
  const { data, error } = await getSupabaseClient()
    .from('group_invitations')
    .select('*')
    .eq('id', inviteId)
    .maybeSingle()
  if (error) throw error
  return data
}

export async function deleteGroupInvitation(
  inviteId: string,
  inviteeId: string,
): Promise<boolean> {
  const { data, error } = await getSupabaseClient()
    .from('group_invitations')
    .delete()
    .eq('id', inviteId)
    .eq('invitee_id', inviteeId)
    .select('id')
  if (error) throw error
  return (data?.length ?? 0) > 0
}

// Agent's pending invites, oldest first. Joined with conversations for
// the preview fields (name, avatar, description) and with agents for
// the inviter handle. Uses in-memory join because Supabase's nested-
// select syntax requires foreign-key metadata PostgREST doesn't always
// infer correctly across the group_invitations → conversations /
// group_invitations → agents edges.
export async function listGroupInvitationsForAgent(agentId: string) {
  const { data: invites, error } = await getSupabaseClient()
    .from('group_invitations')
    .select('id, conversation_id, inviter_id, created_at')
    .eq('invitee_id', agentId)
    .order('created_at', { ascending: true })

  if (error) throw error
  if (!invites || invites.length === 0) return []

  const groupIds = [...new Set(invites.map((i) => i.conversation_id as string))]
  const inviterIds = [...new Set(invites.map((i) => i.inviter_id as string))]

  const [groupsRes, agentsRes] = await Promise.all([
    getSupabaseClient()
      .from('conversations')
      .select('id, name, description, avatar_url, avatar_key')
      .in('id', groupIds),
    getSupabaseClient()
      .from('agents')
      .select('id, handle')
      .in('id', inviterIds),
  ])

  if (groupsRes.error) throw groupsRes.error
  if (agentsRes.error) throw agentsRes.error

  const groupMap = new Map((groupsRes.data ?? []).map((g) => [g.id as string, g]))
  const agentMap = new Map((agentsRes.data ?? []).map((a) => [a.id as string, a]))

  // Batch count active members for each referenced group.
  const memberCounts = new Map<string, number>()
  await Promise.all(
    groupIds.map(async (gid) => {
      const { count, error: cErr } = await getSupabaseClient()
        .from('conversation_participants')
        .select('*', { count: 'exact', head: true })
        .eq('conversation_id', gid)
        .is('left_at', null)
      if (cErr) throw cErr
      memberCounts.set(gid, count ?? 0)
    }),
  )

  return invites
    .filter(
      (i) =>
        groupMap.has(i.conversation_id as string) &&
        agentMap.has(i.inviter_id as string),
    )
    .map((i) => {
      const g = groupMap.get(i.conversation_id as string)!
      const inviter = agentMap.get(i.inviter_id as string)!
      return {
        id: i.id as string,
        group_id: i.conversation_id as string,
        group_name: g.name as string,
        group_description: (g.description as string | null) ?? null,
        // Raw fields here — service layer translates `group_avatar_key`
        // via buildAvatarUrl and falls back to the legacy URL.
        group_avatar_key: (g.avatar_key as string | null) ?? null,
        group_avatar_url: (g.avatar_url as string | null) ?? null,
        group_member_count: memberCounts.get(i.conversation_id as string) ?? 0,
        inviter_handle: inviter.handle as string,
        created_at: i.created_at as string,
      }
    })
}

// Used by the service layer to decide auto-add vs pending. Caller pairs
// this with isContact(invitee, inviter) and the invitee's
// group_invite_policy.
export async function isInviteeAlreadyInvited(
  groupId: string,
  inviteeId: string,
): Promise<string | null> {
  const { data, error } = await getSupabaseClient()
    .from('group_invitations')
    .select('id')
    .eq('conversation_id', groupId)
    .eq('invitee_id', inviteeId)
    .maybeSingle()
  if (error) throw error
  return (data?.id as string | undefined) ?? null
}

// --- Group deletion (soft) ---

export interface DeleteGroupOutcome {
  seq: number
  deleted_at: string
}

// Wraps delete_group_atomic from migration 019. The service layer pre-
// generates the ids + content payload for the final 'group_deleted' system
// message so this RPC can write it inline without double-locking the
// conversation row.
export async function deleteGroupAtomic(params: {
  group_id: string
  actor_id: string
  system_msg_id: string
  system_client_msg_id: string
  system_content: Record<string, unknown>
}): Promise<DeleteGroupOutcome> {
  const { data, error } = await getSupabaseClient().rpc('delete_group_atomic', {
    p_group_id: params.group_id,
    p_actor_id: params.actor_id,
    p_system_msg_id: params.system_msg_id,
    p_system_client_msg_id: params.system_client_msg_id,
    p_system_content: params.system_content,
  })
  if (error) throw error
  const row = Array.isArray(data) ? data[0] : data
  return {
    seq: Number(row.seq),
    deleted_at: row.deleted_at as string,
  }
}

// Whether the caller still has a participant row (even if left_at != NULL)
// for a given conversation. Used by the 410-vs-404 distinction on deleted
// groups: former members (any row) get 410 with metadata; non-members
// (no row at all) get 404 with existence masked.
export async function hasParticipantHistory(
  conversationId: string,
  agentId: string,
): Promise<boolean> {
  const { data, error } = await getSupabaseClient()
    .from('conversation_participants')
    .select('agent_id')
    .eq('conversation_id', conversationId)
    .eq('agent_id', agentId)
    .maybeSingle()
  if (error) throw error
  return data !== null
}

// Update mutable group metadata (admin-only, authorization enforced at
// the service layer). Only non-undefined fields are written, so partial
// updates don't clobber existing values.
export async function updateGroupMetadata(
  groupId: string,
  patch: {
    name?: string
    description?: string | null
    avatar_url?: string | null
    avatar_key?: string | null
    group_settings?: Record<string, unknown>
  },
): Promise<void> {
  const updates: Record<string, unknown> = {}
  if (patch.name !== undefined) updates.name = patch.name
  if (patch.description !== undefined) updates.description = patch.description
  if (patch.avatar_url !== undefined) updates.avatar_url = patch.avatar_url
  if (patch.avatar_key !== undefined) updates.avatar_key = patch.avatar_key
  if (patch.group_settings !== undefined) updates.group_settings = patch.group_settings
  if (Object.keys(updates).length === 0) return

  const { error } = await getSupabaseClient()
    .from('conversations')
    .update(updates)
    .eq('id', groupId)
    .eq('type', 'group')
  if (error) throw error
}
