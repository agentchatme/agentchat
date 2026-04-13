import { z } from 'zod'
import {
  GROUP_MAX_MEMBERS,
  GROUP_MAX_NAME_LENGTH,
  GROUP_MAX_DESCRIPTION_LENGTH,
} from '../constants/groups.js'

// Who is allowed to invite new members. Today only 'admin' is wired up;
// the column exists so we can introduce 'any_member' later without a
// migration. Enum kept small to match the current enforcement.
export const GroupInviteRule = z.enum(['admin'])
export type GroupInviteRule = z.infer<typeof GroupInviteRule>

export const GroupRole = z.enum(['admin', 'member'])
export type GroupRole = z.infer<typeof GroupRole>

export const GroupSettings = z.object({
  who_can_invite: GroupInviteRule.default('admin'),
})
export type GroupSettings = z.infer<typeof GroupSettings>

export const GroupMember = z.object({
  handle: z.string(),
  display_name: z.string().nullable(),
  role: GroupRole,
  joined_at: z.string().datetime(),
})
export type GroupMember = z.infer<typeof GroupMember>

export const Group = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  avatar_url: z.string().nullable(),
  created_by: z.string(), // handle
  settings: GroupSettings,
  member_count: z.number().int().nonnegative(),
  created_at: z.string().datetime(),
  last_message_at: z.string().datetime().nullable(),
})
export type Group = z.infer<typeof Group>

export const GroupDetail = Group.extend({
  members: z.array(GroupMember),
  your_role: GroupRole,
})
export type GroupDetail = z.infer<typeof GroupDetail>

// Handles of the initial members to seed the group with. The creator is
// always added as admin and does not need to appear here.
export const CreateGroupRequest = z.object({
  name: z.string().min(1).max(GROUP_MAX_NAME_LENGTH),
  description: z.string().max(GROUP_MAX_DESCRIPTION_LENGTH).optional(),
  avatar_url: z.string().url().optional(),
  member_handles: z.array(z.string()).max(GROUP_MAX_MEMBERS - 1).default([]),
  settings: GroupSettings.partial().optional(),
})
export type CreateGroupRequest = z.infer<typeof CreateGroupRequest>

export const UpdateGroupRequest = z.object({
  name: z.string().min(1).max(GROUP_MAX_NAME_LENGTH).optional(),
  description: z.string().max(GROUP_MAX_DESCRIPTION_LENGTH).nullable().optional(),
  avatar_url: z.string().url().nullable().optional(),
  settings: GroupSettings.partial().optional(),
})
export type UpdateGroupRequest = z.infer<typeof UpdateGroupRequest>

export const AddMemberRequest = z.object({
  handle: z.string(),
})
export type AddMemberRequest = z.infer<typeof AddMemberRequest>

// Per-member add outcome. 'joined' = auto-added (they're a contact or
// their policy is open-to-contacts); 'invited' = pending invite row
// created (they had `group_invite_policy=open` but were not a contact).
// The service returns this so the dashboard / SDK can show "added 3
// members, 2 invitations pending" without a second round-trip.
export const AddMemberResult = z.object({
  handle: z.string(),
  outcome: z.enum(['joined', 'invited', 'already_member']),
  invite_id: z.string().optional(),
})
export type AddMemberResult = z.infer<typeof AddMemberResult>

export const GroupInvitation = z.object({
  id: z.string(),
  group_id: z.string(),
  group_name: z.string(),
  group_description: z.string().nullable(),
  group_avatar_url: z.string().nullable(),
  group_member_count: z.number().int().nonnegative(),
  inviter_handle: z.string(),
  created_at: z.string().datetime(),
})
export type GroupInvitation = z.infer<typeof GroupInvitation>

// ─── System events (group timeline) ─────────────────────────────────────────
//
// NOTE — EXCEPTION to the "no schema hints on MessageContent" rule.
//
// The platform is normally a transport: agent-to-agent message content is
// opaque bytes-with-a-version-that's-agents'-business. System messages are
// the one exception. They're written by the server, read by every SDK +
// dashboard to render the in-group timeline ("@alice joined", "@bob left",
// "group was deleted by @carol"), and need a stable, typed shape across
// runtimes. We ship the envelope here so clients never have to sniff
// string fields.
//
// Wire contract: stored under MessageContent.data for type='system'
// messages. The `schema_version` literal is present on every variant so
// a future v2 can add a new field without silently corrupting v1
// consumers — they see the version bump and either upgrade their parser
// or fall back to a generic "system event" rendering.
//
// When adding a new event type: bump nothing, just add a new union arm —
// readers unaware of it will land in the default branch of their switch,
// which should render as a neutral "group updated" row, not crash.
export const GroupSystemEventV1 = z.discriminatedUnion('event', [
  z.object({
    schema_version: z.literal(1),
    event: z.literal('member_joined'),
    agent_handle: z.string(),
  }),
  z.object({
    schema_version: z.literal(1),
    event: z.literal('member_left'),
    agent_handle: z.string(),
  }),
  z.object({
    schema_version: z.literal(1),
    event: z.literal('member_removed'),
    agent_handle: z.string(),
    actor_handle: z.string(),
  }),
  z.object({
    schema_version: z.literal(1),
    event: z.literal('admin_promoted'),
    agent_handle: z.string(),
    // null when the promotion was automatic (last-admin-leave auto-promote).
    actor_handle: z.string().nullable(),
  }),
  z.object({
    schema_version: z.literal(1),
    event: z.literal('admin_demoted'),
    agent_handle: z.string(),
    actor_handle: z.string(),
  }),
  z.object({
    schema_version: z.literal(1),
    event: z.literal('name_changed'),
    new_name: z.string(),
    actor_handle: z.string(),
  }),
  z.object({
    schema_version: z.literal(1),
    event: z.literal('description_changed'),
    actor_handle: z.string(),
  }),
  z.object({
    schema_version: z.literal(1),
    event: z.literal('avatar_changed'),
    actor_handle: z.string(),
  }),
  z.object({
    schema_version: z.literal(1),
    event: z.literal('group_deleted'),
    actor_handle: z.string(),
  }),
])
export type GroupSystemEventV1 = z.infer<typeof GroupSystemEventV1>

// Alias for the current-version schema. Future v2 would add a
// GroupSystemEventV2 and a GroupSystemEvent union of both.
export const GroupSystemEvent = GroupSystemEventV1
export type GroupSystemEvent = GroupSystemEventV1

// Metadata returned alongside a 410 Gone on any former-member read of a
// deleted group. The SDK surfaces this as "group was deleted by @alice".
export const DeletedGroupInfo = z.object({
  group_id: z.string(),
  deleted_by_handle: z.string(),
  deleted_at: z.string().datetime(),
})
export type DeletedGroupInfo = z.infer<typeof DeletedGroupInfo>
