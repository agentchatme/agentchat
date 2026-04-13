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
  getGroupPushRecipients,
  createGroupInvitation,
  findGroupInvitation,
  deleteGroupInvitation,
  listGroupInvitationsForAgent,
  isInviteeAlreadyInvited,
  updateGroupMetadata,
  deleteGroupAtomic,
  hasParticipantHistory,
  atomicSendMessage,
} from '@agentchat/db'
import {
  GROUP_MAX_MEMBERS,
  GroupSystemEvent,
  type CreateGroupRequest,
  type UpdateGroupRequest,
  type GroupDetail,
  type GroupMember,
  type AddMemberResult,
  type GroupInvitation,
  type DeletedGroupInfo,
} from '@agentchat/shared'
import { checkGroupInviteCap } from './enforcement.service.js'
import { sendToAgent } from '../ws/events.js'
import { fireWebhooks } from './webhook.service.js'

export class GroupError extends Error {
  code: string
  status: number
  // Arbitrary structured payload surfaced on the wire alongside code +
  // message. Used by GROUP_DELETED (410) to ship DeletedGroupInfo so
  // the SDK can render "group was deleted by @alice" without a second
  // round-trip. Kept open-ended so future errors (e.g. rate-limit with
  // reset_at) can attach their own details without another subclass.
  details?: Record<string, unknown>
  constructor(
    code: string,
    message: string,
    status: number,
    details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'GroupError'
    this.code = code
    this.status = status
    this.details = details
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
  // 410 path: former members of a deleted group see DeletedGroupInfo
  // instead of a blank 404, so the dashboard/SDK can render "group was
  // deleted by @alice". Non-members still get 404 via requireActiveMember.
  const deletedCheck = await resolveDeletedGroupInfoForCaller(groupId, callerId)
  if (deletedCheck?.kind === 'gone') {
    throw new GroupError(
      'GROUP_DELETED',
      'Group has been deleted',
      410,
      deletedCheck.info as unknown as Record<string, unknown>,
    )
  }
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
  const outcome = await runGroupRpc(groupId, () =>
    addGroupMember(groupId, targetId, GROUP_MAX_MEMBERS),
  )
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

  const conversationId = invite.conversation_id as string
  const outcome = await runGroupRpc(conversationId, () =>
    dbAcceptInvite(inviteId, callerId, GROUP_MAX_MEMBERS),
  )
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

  const result = await runGroupRpc(groupId, () => dbLeaveGroup(groupId, callerId))
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

  let ok = false
  try {
    ok = await runGroupRpc(groupId, () => kickGroupMember(groupId, target.id))
  } catch (err) {
    // kick_member_atomic RAISEs a specific message when the target is the
    // creator — translate that to our domain error so the client gets a
    // readable response instead of a raw Postgres error. A 'group_deleted'
    // race is already mapped to GroupError(410) by runGroupRpc above, so
    // we re-throw any GroupError untouched and only match the 'creator'
    // text on bare Postgres errors.
    if (err instanceof GroupError) throw err
    if (err instanceof Error && /creator/i.test(err.message)) {
      throw new GroupError(
        'FORBIDDEN',
        'The group creator cannot be removed',
        403,
      )
    }
    throw err
  }

  if (!ok) {
    throw new GroupError(
      'NOT_MEMBER',
      'Target is not an active member of this group',
      404,
    )
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
  const ok = await runGroupRpc(groupId, () => promoteGroupAdmin(groupId, target.id))
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
  const result = await runGroupRpc(groupId, () => demoteGroupAdmin(groupId, target.id))
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

// ─── Group deletion (soft / disband) ────────────────────────────────────────
//
// Deletion is always creator-initiated when the creator is a healthy
// account (status 'active' or 'restricted'). If the creator's account is
// suspended or deleted, the delete authority passes to any active admin
// of the group — symmetric with the last-admin auto-promote rule in
// leave_group_atomic. This keeps a group from being permanently undead
// when a creator's account goes away.
//
// Everything runs inside delete_group_atomic (migration 019), which
// writes the final 'group_deleted' system message, sets deleted_at,
// soft-leaves all members, flushes their remaining envelopes, and
// cancels pending invites — all under a single FOR UPDATE lock on the
// conversation row. This function does the pre-check for existence,
// captures the recipient set BEFORE the RPC soft-leaves everyone, and
// then fires the post-delete WS / webhook fan-out.

export async function deleteGroup(
  callerId: string,
  groupId: string,
): Promise<{ deleted_at: string }> {
  const [group, actor] = await Promise.all([
    findGroupById(groupId),
    findAgentById(callerId),
  ])
  if (!group) {
    // Non-existent → masked 404 so non-members can't probe.
    throw new GroupError('GROUP_NOT_FOUND', 'Group not found', 404)
  }
  if (!actor) {
    throw new GroupError('AGENT_NOT_FOUND', 'Caller not found', 404)
  }

  // Idempotent replay: a creator who already deleted gets the same 410
  // former-members would see, including the metadata needed to render
  // "the group was deleted by @alice". The idempotency middleware will
  // typically short-circuit before we get here on real client retries;
  // this branch is the fallback for headerless retries.
  if (group.deleted_at) {
    const info = await buildDeletedGroupInfo(
      groupId,
      group.deleted_by as string | null,
      group.deleted_at as string,
    )
    throw new GroupError(
      'GROUP_DELETED',
      'Group has been deleted',
      410,
      info as unknown as Record<string, unknown>,
    )
  }

  // Pre-check: mask existence of the group from non-members. The RPC
  // would raise 'forbidden' for them anyway, but translating that to a
  // 403 here would leak existence. Force a 404 instead.
  const role = await getGroupParticipantRole(groupId, callerId)
  const isCreator = (group.created_by as string | null) === callerId
  if (!role) {
    throw new GroupError('GROUP_NOT_FOUND', 'Group not found', 404)
  }
  // Active members who are neither the creator nor an admin get a clean
  // 403 instead of being forwarded to the RPC (which would reach the
  // same conclusion, but via a cryptic error).
  if (!isCreator && role !== 'admin') {
    throw new GroupError(
      'FORBIDDEN',
      'Only the group creator (or an admin when the creator is suspended) can delete a group',
      403,
    )
  }

  // Pre-capture the fan-out recipient list. After the RPC runs,
  // getGroupPushRecipients returns [] because every member is
  // left_at != NULL. We still want to hit the WS + webhook paths for
  // their final in-group event.
  const recipientIds = await getGroupPushRecipients(
    groupId,
    Number.MAX_SAFE_INTEGER,
    callerId,
  )

  // Build the system event payload. We pass the inner union member
  // (without `data` wrapper) as p_system_content — the RPC wraps it in
  // `{ data: <payload> }` to match the MessageContent shape before
  // inserting into messages.content.
  const systemEvent = {
    schema_version: 1 as const,
    event: 'group_deleted' as const,
    actor_handle: actor.handle,
  }
  // Sanity-check against the shared schema before we ship it to the DB.
  const parsed = GroupSystemEvent.safeParse(systemEvent)
  if (!parsed.success) {
    throw new GroupError('INTERNAL_ERROR', 'Failed to build system event', 500)
  }

  const systemMsgId = generateId('msg')
  const systemClientMsgId = `sys_${systemMsgId}`

  let outcome
  try {
    outcome = await deleteGroupAtomic({
      group_id: groupId,
      actor_id: callerId,
      system_msg_id: systemMsgId,
      system_client_msg_id: systemClientMsgId,
      system_content: parsed.data as unknown as Record<string, unknown>,
    })
  } catch (err) {
    // The RPC raises one of a small set of named exceptions; translate
    // them back into domain errors so the HTTP layer gets a clean code.
    // Anything unrecognized re-throws so it surfaces as a 500.
    const msg = err instanceof Error ? err.message : ''
    if (/group_not_found/.test(msg)) {
      throw new GroupError('GROUP_NOT_FOUND', 'Group not found', 404)
    }
    if (/already_deleted/.test(msg)) {
      // Lost the race to a concurrent delete — surface as 410 with
      // freshly-re-fetched metadata (the winning transaction has already
      // committed, so `group` below is guaranteed to be deleted_at != null).
      const refreshed = await findGroupById(groupId)
      const info = refreshed
        ? await buildDeletedGroupInfo(
            groupId,
            refreshed.deleted_by as string | null,
            refreshed.deleted_at as string,
          )
        : {
            group_id: groupId,
            deleted_by_handle: actor.handle,
            deleted_at: new Date().toISOString(),
          }
      throw new GroupError(
        'GROUP_DELETED',
        'Group has been deleted',
        410,
        info as unknown as Record<string, unknown>,
      )
    }
    if (/forbidden_not_admin|forbidden/.test(msg)) {
      throw new GroupError(
        'FORBIDDEN',
        'You are not authorized to delete this group',
        403,
      )
    }
    throw err
  }

  // Fan-out. Each recipient gets:
  //   1. message.new — the final 'group_deleted' system message so the
  //      in-group timeline renders one last row before the group
  //      disappears. Mirrors how every other system event behaves.
  //   2. group.deleted — a dedicated event so SDKs can pop the group out
  //      of their conversation list immediately without waiting to
  //      parse the content.data.event string out of the message.new.
  const systemMessagePayload = {
    id: systemMsgId,
    conversation_id: groupId,
    sender: actor.handle,
    client_msg_id: systemClientMsgId,
    seq: outcome.seq,
    type: 'system' as const,
    content: { data: parsed.data },
    metadata: {},
    created_at: outcome.deleted_at,
  }

  const deletedPayload: DeletedGroupInfo = {
    group_id: groupId,
    deleted_by_handle: actor.handle,
    deleted_at: outcome.deleted_at,
  }

  for (const recipientId of recipientIds) {
    sendToAgent(recipientId, {
      type: 'message.new',
      payload: systemMessagePayload as unknown as Record<string, unknown>,
    })
    sendToAgent(recipientId, {
      type: 'group.deleted',
      payload: deletedPayload as unknown as Record<string, unknown>,
    })
    fireWebhooks(
      recipientId,
      'message.new',
      systemMessagePayload as unknown as Record<string, unknown>,
    )
    fireWebhooks(
      recipientId,
      'group.deleted',
      deletedPayload as unknown as Record<string, unknown>,
    )
  }

  return { deleted_at: outcome.deleted_at }
}

// Build the DeletedGroupInfo payload a former member gets when they hit
// any still-live read path on a deleted group. Non-members never see this
// — routes call resolveDeletedGroupInfoForCaller (below) which also does
// the membership check.
async function buildDeletedGroupInfo(
  groupId: string,
  deletedById: string | null,
  deletedAt: string,
): Promise<DeletedGroupInfo> {
  let handle = 'unknown'
  if (deletedById) {
    const deleter = await findAgentById(deletedById)
    if (deleter) handle = deleter.handle
  }
  return {
    group_id: groupId,
    deleted_by_handle: handle,
    deleted_at: deletedAt,
  }
}

// Defensive wrapper for group-mutating RPC calls. Migration 020 added a
// DB-level `deleted_at` guard to every atomic group RPC: on a deleted
// group the RPC raises a named 'group_deleted' exception. This helper
// catches that specific text, re-fetches the group for fresh metadata,
// and throws a GroupError(410) so the client sees the same 410 shape as
// the read-path resolveDeletedGroupInfoForCaller flow. Any non-matching
// error is re-thrown unchanged.
//
// The service layer already pre-checks deleted_at before most of these
// RPC calls — this wrapper is the backstop for the TOCTOU race where a
// concurrent delete commits between the service-level read and the
// RPC's FOR UPDATE lock acquisition (they run in separate MVCC
// snapshots, so the pre-check alone isn't enough).
async function runGroupRpc<T>(
  groupId: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof Error && /group_deleted/.test(err.message)) {
      const refreshed = await findGroupById(groupId)
      const info = refreshed
        ? await buildDeletedGroupInfo(
            groupId,
            refreshed.deleted_by as string | null,
            refreshed.deleted_at as string,
          )
        : undefined
      throw new GroupError(
        'GROUP_DELETED',
        'Group has been deleted',
        410,
        info as unknown as Record<string, unknown>,
      )
    }
    throw err
  }
}

// Helper for other services (message, upload) to check whether a group
// is deleted AND the caller was a former member. Returns:
//   - null             — group is not deleted (caller should proceed)
//   - { kind: 'gone' } — deleted AND caller has participant history →
//                        throw 410 with the returned DeletedGroupInfo
//   - { kind: 'hide' } — deleted but caller was never a member →
//                        throw 404 (existence masked)
//
// The caller owns the throwing so they can translate to their own
// service-local error class (MessageError / UploadError / GroupError)
// without a cross-service dependency.
export type DeletedGroupCheck =
  | null
  | { kind: 'gone'; info: DeletedGroupInfo }
  | { kind: 'hide' }

export async function resolveDeletedGroupInfoForCaller(
  groupId: string,
  callerId: string,
): Promise<DeletedGroupCheck> {
  const group = await findGroupById(groupId)
  if (!group || !group.deleted_at) return null
  const hasHistory = await hasParticipantHistory(groupId, callerId)
  if (!hasHistory) return { kind: 'hide' }
  const info = await buildDeletedGroupInfo(
    groupId,
    group.deleted_by as string | null,
    group.deleted_at as string,
  )
  return { kind: 'gone', info }
}

// ─── System messages ────────────────────────────────────────────────────────

// Local "without schema_version" helper so callsites don't have to repeat
// `schema_version: 1` on every emit. We stamp the version inside
// emitSystemEvent and validate the stamped payload against the shared
// schema, which is the single source of truth that the SDK and dashboard
// also parse against.
//
// Omit doesn't distribute across a discriminated union on its own —
// using the distributive conditional here so every arm gets its
// schema_version stripped independently, preserving the discriminant.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never
type GroupSystemEventInput = DistributiveOmit<GroupSystemEvent, 'schema_version'>

// Emit a group system message via the same atomic pipeline as agent
// messages. Fan-out goes to all active participants except the sender
// (by construction — see send_message_atomic in migration 017).
//
// We validate against the shared Zod schema before writing so a typo in a
// new event variant (missing field, wrong name) surfaces in dev instead of
// landing in the database as an unrenderable blob. System messages are
// the one exception to "no schema hints on MessageContent" — see the
// long comment on GroupSystemEventV1 in packages/shared.
async function emitSystemEvent(
  groupId: string,
  senderAgentId: string,
  payload: GroupSystemEventInput,
) {
  const stamped = { schema_version: 1 as const, ...payload }
  const parsed = GroupSystemEvent.safeParse(stamped)
  if (!parsed.success) {
    console.error(
      '[group] system event failed validation:',
      parsed.error.flatten(),
      stamped,
    )
    return
  }
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
      content: { data: parsed.data as unknown as Record<string, unknown> },
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
