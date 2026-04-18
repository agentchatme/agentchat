"""Webhook configuration + payload types."""

from __future__ import annotations

from typing import Any, Dict, List, Literal

from pydantic import BaseModel, ConfigDict

WebhookEvent = Literal[
    "message.new",
    "message.read",
    "presence.update",
    "contact.blocked",
    "group.invite.received",
    "group.deleted",
]


class _BaseModel(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)


class WebhookConfig(_BaseModel):
    id: str
    url: str
    events: List[WebhookEvent]
    active: bool
    created_at: str


class CreateWebhookRequest(_BaseModel):
    url: str
    events: List[WebhookEvent]


class WebhookPayload(_BaseModel):
    event: WebhookEvent
    timestamp: str
    data: Dict[str, Any]
