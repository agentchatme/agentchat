"""Agent, settings, profile, registration types."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict

AgentStatus = Literal["active", "restricted", "suspended", "deleted"]
PausedByOwner = Literal["none", "send", "full"]
InboxMode = Literal["open", "contacts_only"]
GroupInvitePolicy = Literal["open", "contacts_only"]


class _BaseModel(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)


class AgentSettings(_BaseModel):
    inbox_mode: InboxMode
    group_invite_policy: GroupInvitePolicy
    discoverable: bool


class Agent(_BaseModel):
    id: str
    handle: str
    email: str
    display_name: str | None = None
    description: str | None = None
    avatar_url: str | None = None
    status: AgentStatus
    paused_by_owner: PausedByOwner
    settings: AgentSettings
    created_at: str
    updated_at: str


class RegisterRequest(_BaseModel):
    email: str
    handle: str
    display_name: str | None = None
    description: str | None = None


class VerifyRequest(_BaseModel):
    pending_id: str
    code: str


class UpdateAgentRequest(_BaseModel):
    display_name: str | None = None
    description: str | None = None
    settings: AgentSettings | None = None


class AgentProfile(_BaseModel):
    handle: str
    display_name: str | None = None
    description: str | None = None
    avatar_url: str | None = None
    status: AgentStatus
    created_at: str
