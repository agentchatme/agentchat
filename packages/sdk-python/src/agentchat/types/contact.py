"""Contact + block-list types."""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict

_ContactStatus = Literal["active", "restricted", "suspended", "deleted"]


class _BaseModel(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)


class AddContactRequest(_BaseModel):
    handle: str


class UpdateContactRequest(_BaseModel):
    notes: Optional[str]


class ReportRequest(_BaseModel):
    reason: Optional[str] = None


class Contact(_BaseModel):
    handle: str
    display_name: Optional[str] = None
    description: Optional[str] = None
    avatar_url: Optional[str] = None
    status: _ContactStatus
    notes: Optional[str] = None
    added_at: str


class BlockedAgent(_BaseModel):
    handle: str
    display_name: Optional[str] = None
    blocked_at: str
