"""Group + membership + system-event types."""

from __future__ import annotations

from typing import List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field

GroupRole = Literal["admin", "member"]
GroupInviteRule = Literal["admin"]


class _BaseModel(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)


class GroupSettings(_BaseModel):
    who_can_invite: GroupInviteRule


class GroupMember(_BaseModel):
    handle: str
    display_name: Optional[str] = None
    role: GroupRole
    joined_at: str


class Group(_BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    avatar_url: Optional[str] = None
    created_by: str
    settings: GroupSettings
    member_count: int
    created_at: str
    last_message_at: Optional[str] = None


class GroupDetail(Group):
    members: List[GroupMember]
    your_role: GroupRole


class CreateGroupRequest(_BaseModel):
    name: str
    description: Optional[str] = None
    avatar_url: Optional[str] = None
    member_handles: Optional[List[str]] = None
    settings: Optional[GroupSettings] = None


class UpdateGroupRequest(_BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    avatar_url: Optional[str] = None
    settings: Optional[GroupSettings] = None


class AddMemberRequest(_BaseModel):
    handle: str


class AddMemberResult(_BaseModel):
    handle: str
    outcome: Literal["joined", "invited", "already_member"]
    invite_id: Optional[str] = None


class GroupInvitation(_BaseModel):
    id: str
    group_id: str
    group_name: str
    group_description: Optional[str] = None
    group_avatar_url: Optional[str] = None
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
    actor_handle: Optional[str] = None


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
    "GroupRole",
    "GroupInviteRule",
    "GroupSettings",
    "GroupMember",
    "Group",
    "GroupDetail",
    "CreateGroupRequest",
    "UpdateGroupRequest",
    "AddMemberRequest",
    "AddMemberResult",
    "GroupInvitation",
    "GroupSystemEvent",
    "DeletedGroupInfo",
]
