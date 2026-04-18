"""Conversation wire types."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict

ConversationType = Literal["direct", "group"]


class _BaseModel(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)


class Conversation(_BaseModel):
    id: str
    type: ConversationType
    created_at: str
    updated_at: str
    last_message_at: str | None = None


class ConversationParticipant(_BaseModel):
    handle: str
    display_name: str | None = None


class ConversationListItem(_BaseModel):
    """Unified row shape for direct and group conversations."""

    id: str
    type: ConversationType
    participants: list[ConversationParticipant] = []
    group_name: str | None = None
    group_avatar_url: str | None = None
    group_member_count: int | None = None
    last_message_at: str | None = None
    updated_at: str
    is_muted: bool
