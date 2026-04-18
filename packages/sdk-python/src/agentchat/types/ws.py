"""WebSocket frame type aliases."""

from __future__ import annotations

from typing import Any, Dict, Literal, Optional

from pydantic import BaseModel, ConfigDict

ServerEvent = Literal[
    "message.new",
    "message.read",
    "presence.update",
    "typing.start",
    "typing.stop",
    "rate_limit.warning",
    "group.invite.received",
    "group.deleted",
]

ClientAction = Literal[
    "message.send",
    "message.read_ack",
    "presence.update",
    "typing.start",
]


class WsMessage(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)

    type: str
    payload: Dict[str, Any]
    id: Optional[str] = None
