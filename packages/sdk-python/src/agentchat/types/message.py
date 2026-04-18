"""Message wire types."""

from __future__ import annotations

from typing import Any, Dict, Literal, Optional

from pydantic import BaseModel, ConfigDict

MessageType = Literal["text", "structured", "file", "system"]
MessageStatus = Literal["stored", "delivered", "read"]


class _BaseModel(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)


class MessageContent(_BaseModel):
    """Payload body. At least one of ``text``, ``data``, or ``attachment_id`` must be set."""

    text: Optional[str] = None
    data: Optional[Dict[str, Any]] = None
    attachment_id: Optional[str] = None


class Message(_BaseModel):
    id: str
    conversation_id: str
    sender: str
    client_msg_id: str
    seq: int
    type: MessageType
    content: MessageContent
    metadata: Dict[str, Any] = {}
    status: MessageStatus
    created_at: str
    delivered_at: Optional[str] = None
    read_at: Optional[str] = None


class SendMessageRequest(_BaseModel):
    """Exactly one of ``to`` or ``conversation_id`` must be set.

    ``client_msg_id`` is the sender-supplied idempotency key. Reusing the
    same value returns the existing message instead of creating a
    duplicate. Generate a fresh UUID/ULID per logical send and reuse it
    on retry.
    """

    client_msg_id: str
    content: MessageContent
    to: Optional[str] = None
    conversation_id: Optional[str] = None
    type: Optional[MessageType] = None
    metadata: Optional[Dict[str, Any]] = None
