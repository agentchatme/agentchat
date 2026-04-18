"""Conversation wire types."""

from __future__ import annotations

from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict

ConversationType = Literal["direct", "group"]


class _BaseModel(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)


class Conversation(_BaseModel):
    id: str
    type: ConversationType
    created_at: str
    updated_at: str
    last_message_at: Optional[str] = None


class ConversationParticipant(_BaseModel):
    handle: str
    display_name: Optional[str] = None


class ConversationListItem(_BaseModel):
    """Unified row shape for direct and group conversations."""

    id: str
    type: ConversationType
    participants: List[ConversationParticipant] = []
    group_name: Optional[str] = None
    group_avatar_url: Optional[str] = None
    group_member_count: Optional[int] = None
    last_message_at: Optional[str] = None
    updated_at: str
    is_muted: bool
