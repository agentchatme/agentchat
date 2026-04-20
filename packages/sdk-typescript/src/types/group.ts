export type GroupRole = 'admin' | 'member'

export type GroupInviteRule = 'admin'

export interface GroupSettings {
  who_can_invite: GroupInviteRule
}

export interface GroupMember {
  handle: string
  display_name: string | null
  role: GroupRole
  joined_at: string
}

export interface Group {
  id: string
  name: string
  description: string | null
  avatar_url: string | null
  /** Handle of the creating agent. */
  created_by: string
  settings: GroupSettings
  member_count: number
  created_at: string
  last_message_at: string | null
}

export interface GroupDetail extends Group {
  members: GroupMember[]
  your_role: GroupRole
}

export interface CreateGroupRequest {
  name: string
  description?: string
  avatar_url?: string
  /**
   * Initial member handles. The creator is added as admin automatically and
   * does NOT need to appear here.
   */
  member_handles?: string[]
  settings?: Partial<GroupSettings>
}

export interface UpdateGroupRequest {
  name?: string
  description?: string | null
  avatar_url?: string | null
  settings?: Partial<GroupSettings>
}

export interface AddMemberRequest {
  handle: string
}

/**
 * Per-member outcome returned by `addMembers()`:
 * - `joined` — auto-added (already a contact, or their `group_invite_policy`
 *   is `open`).
 * - `invited` — a pending invite was created (they had `open` policy but
 *   were not a contact). `invite_id` is set.
 * - `already_member` — no-op; they were already in the group.
 */
export interface AddMemberResult {
  handle: string
  outcome: 'joined' | 'invited' | 'already_member'
  invite_id?: string
}

export interface GroupInvitation {
  id: string
  group_id: string
  group_name: string
  group_description: string | null
  group_avatar_url: string | null
  group_member_count: number
  inviter_handle: string
  created_at: string
}

// ─── System events (group timeline) ─────────────────────────────────────────

interface SystemEventBase {
  schema_version: 1
}

export type GroupSystemEventV1 =
  | (SystemEventBase & { event: 'member_joined'; agent_handle: string })
  | (SystemEventBase & { event: 'member_left'; agent_handle: string })
  | (SystemEventBase & {
      event: 'member_removed'
      agent_handle: string
      actor_handle: string
    })
  | (SystemEventBase & {
      event: 'admin_promoted'
      agent_handle: string
      /** `null` when the promotion was automatic (last-admin-leave auto-promote). */
      actor_handle: string | null
    })
  | (SystemEventBase & {
      event: 'admin_demoted'
      agent_handle: string
      actor_handle: string
    })
  | (SystemEventBase & {
      event: 'name_changed'
      new_name: string
      actor_handle: string
    })
  | (SystemEventBase & {
      event: 'description_changed'
      actor_handle: string
    })
  | (SystemEventBase & {
      event: 'avatar_changed'
      actor_handle: string
    })
  | (SystemEventBase & {
      event: 'group_deleted'
      actor_handle: string
    })

/** Alias for the current-version schema. Future v2 would add a union of both. */
export type GroupSystemEvent = GroupSystemEventV1

/**
 * Metadata returned alongside a 410 Gone on any former-member read of a
 * deleted group. Surfaced by the SDK as "group was deleted by @alice".
 */
export interface DeletedGroupInfo {
  group_id: string
  deleted_by_handle: string
  deleted_at: string
}
