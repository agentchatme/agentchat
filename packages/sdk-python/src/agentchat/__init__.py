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

from ._client import AgentChatClient, AsyncAgentChatClient
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
from ._version import VERSION
from ._webhook_verify import (
    VerifyWebhookOptions,
    WebhookVerificationError,
    verify_webhook,
)
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

__all__ = [
    "DEFAULT_RETRY_POLICY",
    "VERSION",
    # Clients
    "AgentChatClient",
    # Errors
    "AgentChatError",
    "AgentChatErrorResponse",
    "AsyncAgentChatClient",
    # HTTP transport (advanced)
    "AsyncHttpTransport",
    "BlockedError",
    "ConnectHandler",
    "ConnectionError",
    "DisconnectHandler",
    "ErrorCode",
    "ErrorHandler",
    "ErrorInfo",
    "ForbiddenError",
    "GroupDeletedError",
    "HttpResponse",
    "HttpTransport",
    "HttpTransportOptions",
    "MessageHandler",
    "NotFoundError",
    "RateLimitedError",
    # Realtime
    "RealtimeClient",
    "RealtimeOptions",
    "RecipientBackloggedError",
    "RequestHooks",
    "RequestInfo",
    "ResponseInfo",
    "RestrictedError",
    "RetryInfo",
    "RetryPolicy",
    "SequenceGapHandler",
    "SequenceGapInfo",
    "ServerError",
    "SuspendedError",
    "UnauthorizedError",
    "ValidationError",
    "VerifyWebhookOptions",
    "WebhookVerificationError",
    "apaginate",
    "create_agentchat_error",
    # Helpers
    "paginate",
    "parse_retry_after",
    "verify_webhook",
]
