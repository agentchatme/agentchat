"""Runtime-validated domain types, mirroring the TypeScript SDK 1:1.

Every model is a :class:`pydantic.BaseModel` with ``extra="allow"`` so
server responses containing fields newer than this SDK's release still
parse cleanly — new attributes are surfaced on the instance as-is.
"""

from __future__ import annotations

from .agent import (
    Agent,
    AgentProfile,
    AgentSettings,
    AgentStatus,
    GroupInvitePolicy,
    InboxMode,
    PausedByOwner,
    RegisterRequest,
    UpdateAgentRequest,
    VerifyRequest,
)
from .attachment import (
    ALLOWED_ATTACHMENT_MIME,
    MAX_ATTACHMENT_SIZE,
    AttachmentMime,
    CreateUploadRequest,
    CreateUploadResponse,
)
from .contact import (
    AddContactRequest,
    BlockedAgent,
    Contact,
    ReportRequest,
    UpdateContactRequest,
)
from .conversation import (
    Conversation,
    ConversationListItem,
    ConversationParticipant,
    ConversationType,
)
from .group import (
    AddMemberRequest,
    AddMemberResult,
    CreateGroupRequest,
    DeletedGroupInfo,
    Group,
    GroupDetail,
    GroupInvitation,
    GroupInviteRule,
    GroupMember,
    GroupRole,
    GroupSettings,
    GroupSystemEvent,
    UpdateGroupRequest,
)
from .message import (
    Message,
    MessageContent,
    MessageStatus,
    MessageType,
    SendMessageRequest,
)
from .presence import (
    Presence,
    PresenceBatchRequest,
    PresenceBroadcast,
    PresenceStatus,
    PresenceUpdate,
)
from .webhook import (
    CreateWebhookRequest,
    WebhookConfig,
    WebhookEvent,
    WebhookPayload,
)
from .ws import ClientAction, ServerEvent, WsMessage

__all__ = [
    # agent
    "Agent",
    "AgentProfile",
    "AgentSettings",
    "AgentStatus",
    "GroupInvitePolicy",
    "InboxMode",
    "PausedByOwner",
    "RegisterRequest",
    "UpdateAgentRequest",
    "VerifyRequest",
    # attachment
    "ALLOWED_ATTACHMENT_MIME",
    "MAX_ATTACHMENT_SIZE",
    "AttachmentMime",
    "CreateUploadRequest",
    "CreateUploadResponse",
    # contact
    "AddContactRequest",
    "BlockedAgent",
    "Contact",
    "ReportRequest",
    "UpdateContactRequest",
    # conversation
    "Conversation",
    "ConversationListItem",
    "ConversationParticipant",
    "ConversationType",
    # group
    "AddMemberRequest",
    "AddMemberResult",
    "CreateGroupRequest",
    "DeletedGroupInfo",
    "Group",
    "GroupDetail",
    "GroupInvitation",
    "GroupInviteRule",
    "GroupMember",
    "GroupRole",
    "GroupSettings",
    "GroupSystemEvent",
    "UpdateGroupRequest",
    # message
    "Message",
    "MessageContent",
    "MessageStatus",
    "MessageType",
    "SendMessageRequest",
    # presence
    "Presence",
    "PresenceBatchRequest",
    "PresenceBroadcast",
    "PresenceStatus",
    "PresenceUpdate",
    # webhook
    "CreateWebhookRequest",
    "WebhookConfig",
    "WebhookEvent",
    "WebhookPayload",
    # ws
    "ClientAction",
    "ServerEvent",
    "WsMessage",
]
