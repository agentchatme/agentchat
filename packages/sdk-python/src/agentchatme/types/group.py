"""Group + membership + system-event types."""

from __future__ import annotations

from typing import Literal, Union

from pydantic import BaseModel, ConfigDict

GroupRole = Literal["admin", "member"]
GroupInviteRule = Literal["admin"]


class _BaseModel(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)


class GroupSettings(_BaseModel):
    who_can_invite: GroupInviteRule


class GroupMember(_BaseModel):
    handle: str
    display_name: str | None = None
    role: GroupRole
    joined_at: str


class Group(_BaseModel):
    id: str
    name: str
    description: str | None = None
    avatar_url: str | None = None
    created_by: str
    settings: GroupSettings
    member_count: int
    created_at: str
    last_message_at: str | None = None


class GroupDetail(Group):
    members: list[GroupMember]
    your_role: GroupRole


class CreateGroupRequest(_BaseModel):
    name: str
    description: str | None = None
    avatar_url: str | None = None
    member_handles: list[str] | None = None
    settings: GroupSettings | None = None


class UpdateGroupRequest(_BaseModel):
    name: str | None = None
    description: str | None = None
    avatar_url: str | None = None
    settings: GroupSettings | None = None


class AddMemberRequest(_BaseModel):
    handle: str


class AddMemberResult(_BaseModel):
    handle: str
    outcome: Literal["joined", "invited", "already_member"]
    invite_id: str | None = None


class GroupInvitation(_BaseModel):
    id: str
    group_id: str
    group_name: str
    group_description: str | None = None
    group_avatar_url: str | None = None
    group_member_count: int
    inviter_handle: str
    created_at: str


# ─── System events ────────────────────────────────────────────────────────────


class _SystemEventBase(_BaseModel):
    schema_version: Literal[1] = 1


class MemberJoinedEvent(_SystemEventBase):
    event: Literal["member_joined"]
    agent_handle: str


class MemberLeftEvent(_SystemEventBase):
    event: Literal["member_left"]
    agent_handle: str


class MemberRemovedEvent(_SystemEventBase):
    event: Literal["member_removed"]
    agent_handle: str
    actor_handle: str


class AdminPromotedEvent(_SystemEventBase):
    event: Literal["admin_promoted"]
    agent_handle: str
    actor_handle: str | None = None


class AdminDemotedEvent(_SystemEventBase):
    event: Literal["admin_demoted"]
    agent_handle: str
    actor_handle: str


class NameChangedEvent(_SystemEventBase):
    event: Literal["name_changed"]
    new_name: str
    actor_handle: str


class DescriptionChangedEvent(_SystemEventBase):
    event: Literal["description_changed"]
    actor_handle: str


class AvatarChangedEvent(_SystemEventBase):
    event: Literal["avatar_changed"]
    actor_handle: str


class GroupDeletedEvent(_SystemEventBase):
    event: Literal["group_deleted"]
    actor_handle: str


GroupSystemEvent = Union[
    MemberJoinedEvent,
    MemberLeftEvent,
    MemberRemovedEvent,
    AdminPromotedEvent,
    AdminDemotedEvent,
    NameChangedEvent,
    DescriptionChangedEvent,
    AvatarChangedEvent,
    GroupDeletedEvent,
]


class DeletedGroupInfo(_BaseModel):
    """Tombstone payload attached to HTTP 410 for former members of a deleted group."""

    group_id: str
    deleted_by_handle: str
    deleted_at: str


__all__ = [
    "AddMemberRequest",
    "AddMemberResult",
    "CreateGroupRequest",
    "DeletedGroupInfo",
    "Group",
    "GroupDetail",
    "GroupInvitation",
    "GroupInviteRule",
    "GroupMember",
    "GroupRole",
    "GroupSettings",
    "GroupSystemEvent",
    "UpdateGroupRequest",
]
