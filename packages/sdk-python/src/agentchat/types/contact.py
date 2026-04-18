"""Contact + block-list types."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict

_ContactStatus = Literal["active", "restricted", "suspended", "deleted"]


class _BaseModel(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)


class AddContactRequest(_BaseModel):
    handle: str


class UpdateContactRequest(_BaseModel):
    notes: str | None


class ReportRequest(_BaseModel):
    reason: str | None = None


class Contact(_BaseModel):
    handle: str
    display_name: str | None = None
    description: str | None = None
    avatar_url: str | None = None
    status: _ContactStatus
    notes: str | None = None
    added_at: str


class BlockedAgent(_BaseModel):
    handle: str
    display_name: str | None = None
    blocked_at: str
