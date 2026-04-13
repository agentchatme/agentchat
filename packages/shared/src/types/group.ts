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
