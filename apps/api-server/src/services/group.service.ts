import { generateId } from '../lib/id.js'
import {
  findAgentByHandle,
  findAgentById,
  isContact,
  isBlockedEither,
  createGroup as dbCreateGroup,
  addGroupMember,
  acceptGroupInvite as dbAcceptInvite,
  leaveGroup as dbLeaveGroup,
  kickGroupMember,
  promoteGroupAdmin,
  demoteGroupAdmin,
  findGroupById,
  getGroupMembers,
  getGroupMemberCount,
  getGroupParticipantRole,
  createGroupInvitation,
  findGroupInvitation,
  deleteGroupInvitation,
  listGroupInvitationsForAgent,
  isInviteeAlreadyInvited,
  updateGroupMetadata,
  atomicSendMessage,
} from '@agentchat/db'
import {
  GROUP_MAX_MEMBERS,
  type CreateGroupRequest,
  type UpdateGroupRequest,
  type GroupDetail,
  type GroupMember,
  type AddMemberResult,
  type GroupInvitation,
} from '@agentchat/shared'
import { checkGroupInviteCap } from './enforcement.service.js'
import { sendToAgent } from '../ws/events.js'
import { fireWebhooks } from './webhook.service.js'

export class GroupError extends Error {
  code: string
  status: number
  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'GroupError'
    this.code = code
    this.status = status
  }
}

// ─── Lookups / authorization helpers ────────────────────────────────────────

async function loadGroupOrThrow(groupId: string) {
  const group = await findGroupById(groupId)
  if (!group) {
    throw new GroupError('GROUP_NOT_FOUND', 'Group not found', 404)
  }
  return group
}

async function requireActiveMember(groupId: string, agentId: string) {
  const role = await getGroupParticipantRole(groupId, agentId)
  if (!role) {
    // Mask as NOT_FOUND so non-members can't probe group existence.
    throw new GroupError('GROUP_NOT_FOUND', 'Group not found', 404)
  }
  return role
}

async function requireAdmin(groupId: string, agentId: string) {
  const role = await requireActiveMember(groupId, agentId)
  if (role !== 'admin') {
    throw new GroupError(
      'FORBIDDEN',
      'Only group admins can perform this action',
      403,
    )
  }
}

async function loadAgentByHandleOrThrow(rawHandle: string) {
  const normalized = rawHandle.replace(/^@/, '').toLowerCase()
  const agent = await findAgentByHandle(normalized)
  if (!agent) {
    throw new GroupError('AGENT_NOT_FOUND', `Account @${normalized} not found`, 404)
  }
  return agent
}

// ─── Group create / read / update ───────────────────────────────────────────

export async function createGroup(
  creatorId: string,
  req: CreateGroupRequest,
): Promise<{ group: GroupDetail; add_results: AddMemberResult[] }> {
  const creator = await findAgentById(creatorId)
  if (!creator) {
    throw new GroupError('AGENT_NOT_FOUND', 'Creator account not found', 404)
  }
  if (creator.status === 'suspended') {
    throw new GroupError('SUSPENDED', 'Your account is suspended', 403)
  }

  // Dedupe the initial member list (case-insensitive) and drop any entry
  // that refers to the creator themselves — the creator is always added
  // as admin by create_group_atomic and doesn't need a second pass.
  const cleanedHandles = [
    ...new Set(
      req.member_handles
        .map((h) => h.replace(/^@/, '').toLowerCase())
        .filter((h) => h.length > 0 && h !== creator.handle),
    ),
  ]

  const groupId = generateId('grp')
  await dbCreateGroup({
    id: groupId,
    creator_id: creatorId,
    name: req.name,
    description: req.description ?? null,
    avatar_url: req.avatar_url ?? null,
    settings: { who_can_invite: req.settings?.who_can_invite ?? 'admin' },
  })

  // Run the initial member additions through the same addMember code
  // path used for subsequent adds: same contact/policy checks, same
  // auto-add vs pending-invite decision, same invite cap. Failures on an
  // individual handle (not_found, blocked, restricted) don't abort the
  // whole create — they're reported per-handle so the caller can show
  // "added 3, failed 2" without losing the group itself.
  const addResults: AddMemberResult[] = []
  for (const handle of cleanedHandles) {
    try {
      const result = await addMemberByHandle(creatorId, groupId, handle, {
        fromCreate: true,
      })
      addResults.push(result)
    } catch (err) {
      if (err instanceof GroupError) {
        // Swallow per-handle errors but surface them as a "skipped" entry
        // via a synthesized outcome. Using `already_member` would be
        // misleading — instead we drop the failed handle from the result
        // list and the caller sees a partial success.
        continue
      }
      throw err
    }
  }

  const detail = await assembleGroupDetail(groupId, creatorId)
  return { group: detail, add_results: addResults }
}

export async function getGroup(
  callerId: string,
  groupId: string,
): Promise<GroupDetail> {
  await requireActiveMember(groupId, callerId)
  return assembleGroupDetail(groupId, callerId)
}

export async function updateGroup(
  callerId: string,
  groupId: string,
  patch: UpdateGroupRequest,
): Promise<GroupDetail> {
  await requireAdmin(groupId, callerId)
  const before = await loadGroupOrThrow(groupId)

  const beforeSettings = (before.group_settings as Record<string, unknown>) ?? {}
  const nextSettings =
    patch.settings !== undefined
      ? { ...beforeSettings, ...patch.settings }
      : undefined

  await updateGroupMetadata(groupId, {
    name: patch.name,
    description: patch.description,
    avatar_url: patch.avatar_url,
    group_settings: nextSettings,
  })

  const actor = await findAgentById(callerId)
  const actorHandle = actor?.handle ?? 'unknown'

  // One system message per changed field so the group timeline shows
  // discrete events instead of an opaque "metadata updated" blob.
  if (patch.name !== undefined && patch.name !== before.name) {
    await emitSystemEvent(groupId, callerId, {
      event: 'name_changed',
      new_name: patch.name,
      actor_handle: actorHandle,
    })
  }
  if (
    patch.description !== undefined &&
    patch.description !== (before.description ?? null)
  ) {
    await emitSystemEvent(groupId, callerId, {
      event: 'description_changed',
      actor_handle: actorHandle,
    })
  }
  if (
    patch.avatar_url !== undefined &&
    patch.avatar_url !== (before.avatar_url ?? null)
  ) {
    await emitSystemEvent(groupId, callerId, {
      event: 'avatar_changed',
      actor_handle: actorHandle,
    })
  }

  return assembleGroupDetail(groupId, callerId)
}

// ─── Member add: auto-add vs pending-invite decision ────────────────────────

// Shared by both createGroup (initial members) and addMemberToGroup
// (admin-triggered post-create adds). Returns the per-handle outcome and
// does all WS / webhook side effects for the pending-invite case.
async function addMemberByHandle(
  callerId: string,
  groupId: string,
  handle: string,
  opts: { fromCreate?: boolean } = {},
): Promise<AddMemberResult> {
  const normalized = handle.replace(/^@/, '').toLowerCase()
  if (!normalized) {
    throw new GroupError('VALIDATION_ERROR', 'Handle is empty', 400)
  }

  const target = await loadAgentByHandleOrThrow(normalized)
  if (target.id === callerId) {
    throw new GroupError(
      'VALIDATION_ERROR',
      'Cannot invite yourself to your own group',
      400,
    )
  }

  // Block check is direction-agnostic: if either side has blocked the
  // other, we refuse the invite. Groups aren't a backdoor around blocks.
  const blocked = await isBlockedEither(callerId, target.id)
  if (blocked) {
    throw new GroupError(
      'BLOCKED',
      'Messaging between these accounts is blocked',
      403,
    )
  }

  const existingRole = await getGroupParticipantRole(groupId, target.id)
  if (existingRole) {
    return { handle: target.handle, outcome: 'already_member' }
  }

  // Per-sender rate limit: belt-and-suspenders against mass invite spam.
  // Both auto-add and pending invites count toward this cap because
  // both cost the target's attention (a new group in their list OR a
  // pending invite in their invite inbox).
  const capCheck = await checkGroupInviteCap(callerId)
  if (!capCheck.allowed) {
    throw new GroupError(
      'RATE_LIMITED',
      `Daily group-invite limit reached (${capCheck.limit}/day)`,
      429,
    )
  }

  const targetSettings = (target.settings as Record<string, unknown>) ?? {}
  const inviteePolicy =
    (targetSettings.group_invite_policy as string | undefined) ?? 'open'
  const callerIsInTargetContacts = await isContact(target.id, callerId)

  // Policy matrix:
  //   contacts_only + contact    → auto-add
  //   contacts_only + non-contact → REJECT with INBOX_RESTRICTED
  //   open + contact             → auto-add
  //   open + non-contact         → pending invite (LinkedIn-style)
  if (inviteePolicy === 'contacts_only' && !callerIsInTargetContacts) {
    throw new GroupError(
      'INBOX_RESTRICTED',
      'This account only accepts group invites from their contacts',
      403,
    )
  }

  if (callerIsInTargetContacts) {
    const outcome = await dbAddMemberAndEmit(
      groupId,
      target.id,
      callerId,
      target.handle,
    )
    return { handle: target.handle, outcome }
  }

  // Open policy + non-contact: pending invite path. Idempotent upsert on
  // (conversation_id, invitee_id) so retries don't duplicate.
  const existingInviteId = await isInviteeAlreadyInvited(groupId, target.id)
  if (existingInviteId) {
    return { handle: target.handle, outcome: 'invited', invite_id: existingInviteId }
  }

  const inviteId = generateId('gri')
  const { invite_id } = await createGroupInvitation({
    id: inviteId,
    conversation_id: groupId,
    invitee_id: target.id,
    inviter_id: callerId,
  })

  const inviteEnvelope = await buildInviteEnvelope(invite_id)
  if (inviteEnvelope) {
    // Real-time nudge + webhook so the invitee sees the invite even if
    // they're not polling /v1/groups/invites directly. We intentionally
    // don't count this as a "message" for rate-limit purposes — the
    // per-day invite cap covers it.
    sendToAgent(target.id, {
      type: 'group.invite.received',
      payload: inviteEnvelope as unknown as Record<string, unknown>,
    })
    fireWebhooks(target.id, 'group.invite.received', inviteEnvelope)
  }

  void opts
  return { handle: target.handle, outcome: 'invited', invite_id }
}

async function dbAddMemberAndEmit(
  groupId: string,
  targetId: string,
  senderId: string,
  targetHandle: string,
): Promise<'joined' | 'already_member'> {
  const outcome = await addGroupMember(groupId, targetId, GROUP_MAX_MEMBERS)
  if (outcome.status === 'already_member') {
    return 'already_member'
  }
  await emitSystemEvent(groupId, senderId, {
    event: 'member_joined',
    agent_handle: targetHandle,
  })
  return 'joined'
}

export async function addMemberToGroup(
  callerId: string,
  groupId: string,
  handle: string,
): Promise<AddMemberResult> {
  await requireAdmin(groupId, callerId)
  return addMemberByHandle(callerId, groupId, handle)
}

// ─── Accept / reject / list invites ─────────────────────────────────────────

export async function acceptInvite(
  callerId: string,
  inviteId: string,
): Promise<GroupDetail> {
  // acceptInvite uses accept_invite_atomic which verifies (inviteId,
  // callerId) ownership atomically, so we don't need a pre-check here.
  // We still fetch the invite to know the inviter_id for the system
  // message's sender — failing fast with NOT_FOUND if the caller doesn't
  // own a matching invite.
  const invite = await findGroupInvitation(inviteId)
  if (!invite || invite.invitee_id !== callerId) {
    throw new GroupError('INVITE_NOT_FOUND', 'Invite not found', 404)
  }

  const outcome = await dbAcceptInvite(inviteId, callerId, GROUP_MAX_MEMBERS)
  const target = await findAgentById(callerId)
  const targetHandle = target?.handle ?? 'unknown'

  if (outcome.status !== 'already_member') {
    // System message sender is the original inviter so the new member
    // sees "@alice added you" at the top of their in-group history.
    await emitSystemEvent(outcome.conversation_id, invite.inviter_id as string, {
      event: 'member_joined',
      agent_handle: targetHandle,
    })
  }

  return assembleGroupDetail(outcome.conversation_id, callerId)
}

export async function rejectInvite(
  callerId: string,
  inviteId: string,
): Promise<void> {
  const removed = await deleteGroupInvitation(inviteId, callerId)
  if (!removed) {
    throw new GroupError('INVITE_NOT_FOUND', 'Invite not found', 404)
  }
}

export async function listInvites(callerId: string): Promise<GroupInvitation[]> {
  const rows = await listGroupInvitationsForAgent(callerId)
  return rows.map((r) => ({
    id: r.id,
    group_id: r.group_id,
    group_name: r.group_name,
    group_description: r.group_description,
    group_avatar_url: r.group_avatar_url,
    group_member_count: r.group_member_count,
    inviter_handle: r.inviter_handle,
    created_at: r.created_at,
  }))
}

async function buildInviteEnvelope(inviteId: string): Promise<GroupInvitation | null> {
  const invite = await findGroupInvitation(inviteId)
  if (!invite) return null
  const [group, inviter, memberCount] = await Promise.all([
    findGroupById(invite.conversation_id as string),
    findAgentById(invite.inviter_id as string),
    getGroupMemberCount(invite.conversation_id as string),
  ])
  if (!group || !inviter) return null
  return {
    id: invite.id as string,
    group_id: invite.conversation_id as string,
    group_name: (group.name as string | null) ?? '',
    group_description: (group.description as string | null) ?? null,
    group_avatar_url: (group.avatar_url as string | null) ?? null,
    group_member_count: memberCount,
    inviter_handle: inviter.handle,
    created_at: invite.created_at as string,
  }
}

// ─── Leave / kick / promote / demote ────────────────────────────────────────

export async function leaveGroup(
  callerId: string,
  groupId: string,
): Promise<{ promoted_handle: string | null }> {
  await requireActiveMember(groupId, callerId)

  const caller = await findAgentById(callerId)
  const callerHandle = caller?.handle ?? 'unknown'

  const result = await dbLeaveGroup(groupId, callerId)
  if (!result.was_member) {
    // Lost the race to another concurrent leave/kick — treat as already-gone.
    throw new GroupError('GROUP_NOT_FOUND', 'Group not found', 404)
  }

  // Emit AFTER leave_group_atomic so the leaving agent is already
  // left_at != NULL and therefore excluded from the fan-out. The message
  // is visible to everyone still in the group, which is the intended
  // behavior — the leaver's copy is not interesting to themselves.
  await emitSystemEvent(groupId, callerId, {
    event: 'member_left',
    agent_handle: callerHandle,
  })

  let promotedHandle: string | null = null
  if (result.promoted_agent_id) {
    const promoted = await findAgentById(result.promoted_agent_id)
    promotedHandle = promoted?.handle ?? null
    if (promotedHandle) {
      // Sender = the promoted agent themselves (the system picked them,
      // there is no human actor). This keeps send_message_atomic happy
      // (sender_id NOT NULL) without fabricating a synthetic account.
      await emitSystemEvent(groupId, result.promoted_agent_id, {
        event: 'admin_promoted',
        agent_handle: promotedHandle,
        actor_handle: null,
      })
    }
  }

  return { promoted_handle: promotedHandle }
}

export async function kickMember(
  callerId: string,
  groupId: string,
  targetHandle: string,
): Promise<void> {
  await requireAdmin(groupId, callerId)
  const target = await loadAgentByHandleOrThrow(targetHandle)
  if (target.id === callerId) {
    throw new GroupError(
      'VALIDATION_ERROR',
      'Use POST /v1/groups/:id/leave to remove yourself',
      400,
    )
  }

  try {
    const ok = await kickGroupMember(groupId, target.id)
    if (!ok) {
      throw new GroupError(
        'NOT_MEMBER',
        'Target is not an active member of this group',
        404,
      )
    }
  } catch (err) {
    // kick_member_atomic RAISEs a specific message when the target is the
    // creator — translate that to our domain error so the client gets a
    // readable response instead of a raw Postgres error.
    if (err instanceof Error && /creator/i.test(err.message)) {
      throw new GroupError(
        'FORBIDDEN',
        'The group creator cannot be removed',
        403,
      )
    }
    throw err
  }

  const actor = await findAgentById(callerId)
  await emitSystemEvent(groupId, callerId, {
    event: 'member_removed',
    agent_handle: target.handle,
    actor_handle: actor?.handle ?? 'unknown',
  })
}

export async function promoteAdmin(
  callerId: string,
  groupId: string,
  targetHandle: string,
): Promise<void> {
  await requireAdmin(groupId, callerId)
  const target = await loadAgentByHandleOrThrow(targetHandle)
  const ok = await promoteGroupAdmin(groupId, target.id)
  if (!ok) {
    throw new GroupError(
      'NOT_MEMBER',
      'Target is not an active member of this group',
      404,
    )
  }
  const actor = await findAgentById(callerId)
  await emitSystemEvent(groupId, callerId, {
    event: 'admin_promoted',
    agent_handle: target.handle,
    actor_handle: actor?.handle ?? 'unknown',
  })
}

export async function demoteAdmin(
  callerId: string,
  groupId: string,
  targetHandle: string,
): Promise<void> {
  await requireAdmin(groupId, callerId)
  const target = await loadAgentByHandleOrThrow(targetHandle)
  const result = await demoteGroupAdmin(groupId, target.id)
  switch (result) {
    case 'ok':
      break
    case 'not_found':
      throw new GroupError(
        'NOT_MEMBER',
        'Target is not an active member of this group',
        404,
      )
    case 'not_admin':
      throw new GroupError(
        'NOT_ADMIN',
        'Target is not an admin',
        400,
      )
    case 'last_admin':
      throw new GroupError(
        'LAST_ADMIN',
        'Cannot demote the last admin — promote someone else first or leave the group',
        400,
      )
    case 'creator':
      throw new GroupError(
        'FORBIDDEN',
        'The group creator cannot be demoted',
        403,
      )
  }
  const actor = await findAgentById(callerId)
  await emitSystemEvent(groupId, callerId, {
    event: 'admin_demoted',
    agent_handle: target.handle,
    actor_handle: actor?.handle ?? 'unknown',
  })
}

// ─── System messages ────────────────────────────────────────────────────────

type GroupSystemEvent =
  | { event: 'member_joined'; agent_handle: string }
  | { event: 'member_left'; agent_handle: string }
  | { event: 'member_removed'; agent_handle: string; actor_handle: string }
  | {
      event: 'admin_promoted'
      agent_handle: string
      actor_handle: string | null
    }
  | { event: 'admin_demoted'; agent_handle: string; actor_handle: string }
  | { event: 'name_changed'; new_name: string; actor_handle: string }
  | { event: 'description_changed'; actor_handle: string }
  | { event: 'avatar_changed'; actor_handle: string }

// Emit a group system message via the same atomic pipeline as agent
// messages. Fan-out goes to all active participants except the sender
// (by construction — see send_message_atomic in migration 017).
async function emitSystemEvent(
  groupId: string,
  senderAgentId: string,
  payload: GroupSystemEvent,
) {
  const messageId = generateId('msg')
  // client_msg_id for system messages is derived from the id so repeat
  // calls in the same RPC won't collide with the sender's own idempotency
  // namespace. Prefix 'sys_' makes them distinguishable in debugging.
  const clientMsgId = `sys_${messageId}`
  try {
    await atomicSendMessage({
      id: messageId,
      conversation_id: groupId,
      sender_id: senderAgentId,
      client_msg_id: clientMsgId,
      type: 'system',
      content: { data: payload as unknown as Record<string, unknown> },
    })
  } catch (err) {
    // System messages are best-effort — a DB hiccup here shouldn't fail
    // the whole membership mutation, because the DB side is already
    // committed by the time we get here. Log and move on.
    console.error('[group] system message emission failed:', err)
  }
}

// ─── Detail assembly ────────────────────────────────────────────────────────

async function assembleGroupDetail(
  groupId: string,
  callerId: string,
): Promise<GroupDetail> {
  const [group, members, callerRole] = await Promise.all([
    loadGroupOrThrow(groupId),
    getGroupMembers(groupId),
    getGroupParticipantRole(groupId, callerId),
  ])
  if (!callerRole) {
    throw new GroupError('GROUP_NOT_FOUND', 'Group not found', 404)
  }
  const creator = await findAgentById(group.created_by as string)

  const settings = (group.group_settings as Record<string, unknown>) ?? {}
  return {
    id: group.id as string,
    name: (group.name as string | null) ?? '',
    description: (group.description as string | null) ?? null,
    avatar_url: (group.avatar_url as string | null) ?? null,
    created_by: creator?.handle ?? 'unknown',
    settings: {
      who_can_invite:
        (settings.who_can_invite as 'admin' | undefined) ?? 'admin',
    },
    member_count: members.length,
    created_at: group.created_at as string,
    last_message_at: (group.last_message_at as string | null) ?? null,
    members: members as GroupMember[],
    your_role: callerRole,
  }
}
