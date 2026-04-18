"""Message wire types."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

MessageType = Literal["text", "structured", "file", "system"]
MessageStatus = Literal["stored", "delivered", "read"]


class _BaseModel(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)


class MessageContent(_BaseModel):
    """Payload body. At least one of ``text``, ``data``, or ``attachment_id`` must be set."""

    text: str | None = None
    data: dict[str, Any] | None = None
    attachment_id: str | None = None


class Message(_BaseModel):
    id: str
    conversation_id: str
    sender: str
    client_msg_id: str
    seq: int
    type: MessageType
    content: MessageContent
    metadata: dict[str, Any] = {}
    status: MessageStatus
    created_at: str
    delivered_at: str | None = None
    read_at: str | None = None


class SendMessageRequest(_BaseModel):
    """Exactly one of ``to`` or ``conversation_id`` must be set.

    ``client_msg_id`` is the sender-supplied idempotency key. Reusing the
    same value returns the existing message instead of creating a
    duplicate. Generate a fresh UUID/ULID per logical send and reuse it
    on retry.
    """

    client_msg_id: str
    content: MessageContent
    to: str | None = None
    conversation_id: str | None = None
    type: MessageType | None = None
    metadata: dict[str, Any] | None = None
