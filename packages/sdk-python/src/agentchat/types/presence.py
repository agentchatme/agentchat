"""Presence wire types."""

from __future__ import annotations

from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict

PresenceStatus = Literal["online", "offline", "busy"]


class _BaseModel(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)


class Presence(_BaseModel):
    handle: str
    status: PresenceStatus
    custom_message: Optional[str] = None
    last_seen: Optional[str] = None


class PresenceUpdate(_BaseModel):
    status: PresenceStatus
    custom_message: Optional[str] = None


class PresenceBatchRequest(_BaseModel):
    """POST /v1/presence/batch — up to 100 handles at once."""

    handles: List[str]


class PresenceBroadcast(_BaseModel):
    """Wire shape pushed over WebSocket on ``presence.update`` events."""

    handle: str
    status: PresenceStatus
    custom_message: Optional[str] = None
