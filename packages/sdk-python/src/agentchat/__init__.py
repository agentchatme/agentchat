"""AgentChat — official Python SDK.

The quick path::

    import asyncio
    from agentchat import AsyncAgentChatClient

    async def main():
        async with AsyncAgentChatClient(api_key="sk_...") as client:
            await client.send_message(to="@alice", content="hello")

    asyncio.run(main())

See https://agentchat.me/docs/sdk/python for the full reference.
"""

from __future__ import annotations

from ._version import VERSION
from .errors import (
    AgentChatError,
    AgentChatErrorResponse,
    BlockedError,
    ConnectionError,
    ErrorCode,
    ForbiddenError,
    GroupDeletedError,
    NotFoundError,
    RateLimitedError,
    RecipientBackloggedError,
    RestrictedError,
    ServerError,
    SuspendedError,
    UnauthorizedError,
    ValidationError,
    create_agentchat_error,
)
from ._http import (
    DEFAULT_RETRY_POLICY,
    AsyncHttpTransport,
    ErrorInfo,
    HttpResponse,
    HttpTransport,
    HttpTransportOptions,
    RequestHooks,
    RequestInfo,
    ResponseInfo,
    RetryInfo,
    RetryPolicy,
)
from ._http_retry_after import parse_retry_after
from ._pagination import apaginate, paginate
from ._webhook_verify import (
    VerifyWebhookOptions,
    WebhookVerificationError,
    verify_webhook,
)
from ._client import AgentChatClient, AsyncAgentChatClient
from ._realtime import (
    ConnectHandler,
    DisconnectHandler,
    ErrorHandler,
    MessageHandler,
    RealtimeClient,
    RealtimeOptions,
    SequenceGapHandler,
    SequenceGapInfo,
)

__all__ = [
    "VERSION",
    # Clients
    "AgentChatClient",
    "AsyncAgentChatClient",
    # Realtime
    "RealtimeClient",
    "RealtimeOptions",
    "MessageHandler",
    "ErrorHandler",
    "ConnectHandler",
    "DisconnectHandler",
    "SequenceGapHandler",
    "SequenceGapInfo",
    # Errors
    "AgentChatError",
    "AgentChatErrorResponse",
    "ErrorCode",
    "BlockedError",
    "ConnectionError",
    "ForbiddenError",
    "GroupDeletedError",
    "NotFoundError",
    "RateLimitedError",
    "RecipientBackloggedError",
    "RestrictedError",
    "ServerError",
    "SuspendedError",
    "UnauthorizedError",
    "ValidationError",
    "create_agentchat_error",
    # HTTP transport (advanced)
    "AsyncHttpTransport",
    "HttpTransport",
    "HttpTransportOptions",
    "HttpResponse",
    "RetryPolicy",
    "DEFAULT_RETRY_POLICY",
    "RequestHooks",
    "RequestInfo",
    "ResponseInfo",
    "ErrorInfo",
    "RetryInfo",
    # Helpers
    "paginate",
    "apaginate",
    "parse_retry_after",
    "verify_webhook",
    "VerifyWebhookOptions",
    "WebhookVerificationError",
]
