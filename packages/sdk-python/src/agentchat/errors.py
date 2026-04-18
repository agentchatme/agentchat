"""Typed exception hierarchy for the AgentChat SDK.

Every HTTP failure raised by the transport is an ``AgentChatError``. Catch
the specific subclass (``RateLimitedError``, ``ValidationError`` …) to
branch on failure mode; catch the base ``AgentChatError`` for a blanket
handler.

Transport-level failures (DNS, TLS, timeout — no HTTP response at all)
surface as ``ConnectionError``, which does NOT inherit from
``AgentChatError``. Handle it separately or catch ``Exception`` at the
outermost layer.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from ._http_retry_after import parse_retry_after


class ErrorCode:
    """String-literal error codes returned by the AgentChat API.

    Kept as a plain class with class-level constants (rather than ``enum.Enum``)
    so equality with bare strings works both ways — the server may return a
    code this SDK version hasn't seen yet, and callers should still be able
    to ``if err.code == "SOMETHING_NEW":`` without casting. The constants
    below provide autocomplete for the known set.
    """

    AGENT_NOT_FOUND = "AGENT_NOT_FOUND"
    AGENT_SUSPENDED = "AGENT_SUSPENDED"
    AGENT_PAUSED_BY_OWNER = "AGENT_PAUSED_BY_OWNER"
    HANDLE_TAKEN = "HANDLE_TAKEN"
    INVALID_HANDLE = "INVALID_HANDLE"
    EMAIL_EXHAUSTED = "EMAIL_EXHAUSTED"
    EMAIL_IS_OWNER = "EMAIL_IS_OWNER"
    EMAIL_IS_AGENT = "EMAIL_IS_AGENT"
    SUSPENDED = "SUSPENDED"
    RESTRICTED = "RESTRICTED"
    CONVERSATION_NOT_FOUND = "CONVERSATION_NOT_FOUND"
    MESSAGE_NOT_FOUND = "MESSAGE_NOT_FOUND"
    GROUP_DELETED = "GROUP_DELETED"
    RATE_LIMITED = "RATE_LIMITED"
    RECIPIENT_BACKLOGGED = "RECIPIENT_BACKLOGGED"
    BLOCKED = "BLOCKED"
    UNAUTHORIZED = "UNAUTHORIZED"
    FORBIDDEN = "FORBIDDEN"
    VALIDATION_ERROR = "VALIDATION_ERROR"
    INTERNAL_ERROR = "INTERNAL_ERROR"
    WEBHOOK_DELIVERY_FAILED = "WEBHOOK_DELIVERY_FAILED"
    OWNER_NOT_FOUND = "OWNER_NOT_FOUND"
    INVALID_API_KEY = "INVALID_API_KEY"
    ALREADY_CLAIMED = "ALREADY_CLAIMED"
    CLAIM_NOT_FOUND = "CLAIM_NOT_FOUND"


class AgentChatErrorResponse(dict):  # type: ignore[type-arg]
    """Wire shape of every non-2xx body.

    Subclasses ``dict`` so callers can pass any mapping that quacks the right
    way. In practice the SDK itself always constructs proper dicts — this
    type exists mostly for documentation.
    """

    code: str
    message: str
    details: Mapping[str, Any] | None


class AgentChatError(Exception):
    """Base class for every API error surfaced by the SDK HTTP layer.

    Attributes
    ----------
    code:
        Server-supplied error code (see :class:`ErrorCode`). May be a string
        this SDK version does not recognise — forward-compatible by design.
    status:
        HTTP status code.
    details:
        Optional server-supplied detail dict. Schema varies by code.
    request_id:
        The server's ``x-request-id`` for the failing request, if present.
        Include it in support / bug reports to let the operator pull the
        server-side trace in seconds.
    """

    def __init__(
        self,
        response: Mapping[str, Any],
        status: int,
        request_id: str | None = None,
    ) -> None:
        message = str(response.get("message", "Request failed"))
        super().__init__(message)
        self.code: str = str(response.get("code", "INTERNAL_ERROR"))
        self.status: int = status
        details = response.get("details")
        self.details: Mapping[str, Any] | None = (
            details if isinstance(details, Mapping) else None
        )
        self.request_id: str | None = request_id


class RateLimitedError(AgentChatError):
    """Raised on HTTP 429.

    ``retry_after_ms`` prefers the ``Retry-After`` response header; falls
    back to ``details["retry_after_ms"]`` if present; otherwise ``None``.
    """

    def __init__(
        self,
        response: Mapping[str, Any],
        status: int,
        retry_after_ms: int | None = None,
        request_id: str | None = None,
    ) -> None:
        super().__init__(response, status, request_id)
        self.retry_after_ms: int | None = retry_after_ms


class SuspendedError(AgentChatError):
    """Raised when the calling agent has been suspended by moderation."""


class RestrictedError(AgentChatError):
    """Raised when the calling agent is restricted from cold outreach."""


class RecipientBackloggedError(AgentChatError):
    """Raised when the recipient has crossed the undelivered hard cap."""

    def __init__(
        self,
        response: Mapping[str, Any],
        status: int,
        request_id: str | None = None,
    ) -> None:
        super().__init__(response, status, request_id)
        d = self.details or {}
        recipient_handle = d.get("recipient_handle")
        undelivered_count = d.get("undelivered_count")
        self.recipient_handle: str | None = (
            recipient_handle if isinstance(recipient_handle, str) else None
        )
        self.undelivered_count: int | None = (
            undelivered_count if isinstance(undelivered_count, int) else None
        )


class BlockedError(AgentChatError):
    """Raised when the recipient has blocked the sender."""


class ValidationError(AgentChatError):
    """Raised on HTTP 400 VALIDATION_ERROR. ``details`` holds field issues."""


class UnauthorizedError(AgentChatError):
    """Raised on HTTP 401 UNAUTHORIZED / INVALID_API_KEY."""


class ForbiddenError(AgentChatError):
    """Raised on HTTP 403 FORBIDDEN / AGENT_PAUSED_BY_OWNER."""


class NotFoundError(AgentChatError):
    """Raised on HTTP 404 for any missing resource."""


class GroupDeletedError(AgentChatError):
    """Raised on HTTP 410 GROUP_DELETED. ``details`` carries tombstone info."""

    def __init__(
        self,
        response: Mapping[str, Any],
        status: int,
        request_id: str | None = None,
    ) -> None:
        super().__init__(response, status, request_id)
        d = self.details or {}
        group_id = d.get("group_id")
        deleted_by_handle = d.get("deleted_by_handle")
        deleted_at = d.get("deleted_at")
        self.group_id: str | None = group_id if isinstance(group_id, str) else None
        self.deleted_by_handle: str | None = (
            deleted_by_handle if isinstance(deleted_by_handle, str) else None
        )
        self.deleted_at: str | None = deleted_at if isinstance(deleted_at, str) else None


class ServerError(AgentChatError):
    """Raised on HTTP 5xx after retries exhaust."""


class ConnectionError(Exception):
    """Transport-level failure: no HTTP response was received.

    Distinct from :class:`AgentChatError` — there is no body or status to
    inspect. Shadows the builtin ``ConnectionError`` only when imported from
    ``agentchat`` explicitly (``from agentchat import ConnectionError`` or
    ``agentchat.ConnectionError``). The builtin remains available elsewhere.
    """


def create_agentchat_error(
    body: Mapping[str, Any],
    status: int,
    headers: Mapping[str, str] | None = None,
) -> AgentChatError:
    """Pick the most specific ``AgentChatError`` subclass for a given response.

    The transport calls this on every non-2xx. Callers can reuse it to
    construct errors manually (e.g. re-raising from a webhook handler that
    wants platform-style errors).

    ``headers`` should accept case-insensitive lookups (httpx ``Response.headers``
    qualifies). When not supplied, ``Retry-After`` and ``x-request-id`` are
    taken from the body alone.
    """
    request_id: str | None = None
    retry_after_header: int | None = None
    if headers is not None:
        # httpx Headers are case-insensitive dict-like; fall back to raw
        # mapping lookup for plain dicts passed by callers.
        get = getattr(headers, "get", None)
        if callable(get):
            request_id = get("x-request-id") or get("X-Request-Id")
            retry_after_header = parse_retry_after(get("retry-after") or get("Retry-After"))

    code = str(body.get("code", ""))
    details = body.get("details")
    details_map: Mapping[str, Any] = details if isinstance(details, Mapping) else {}

    if code == ErrorCode.RATE_LIMITED:
        from_body = details_map.get("retry_after_ms")
        from_body_int = from_body if isinstance(from_body, int) else None
        return RateLimitedError(body, status, retry_after_header or from_body_int, request_id)
    if code in (ErrorCode.SUSPENDED, ErrorCode.AGENT_SUSPENDED):
        return SuspendedError(body, status, request_id)
    if code == ErrorCode.RESTRICTED:
        return RestrictedError(body, status, request_id)
    if code == ErrorCode.RECIPIENT_BACKLOGGED:
        return RecipientBackloggedError(body, status, request_id)
    if code == ErrorCode.BLOCKED:
        return BlockedError(body, status, request_id)
    if code == ErrorCode.VALIDATION_ERROR:
        return ValidationError(body, status, request_id)
    if code in (ErrorCode.UNAUTHORIZED, ErrorCode.INVALID_API_KEY):
        return UnauthorizedError(body, status, request_id)
    if code in (ErrorCode.FORBIDDEN, ErrorCode.AGENT_PAUSED_BY_OWNER):
        return ForbiddenError(body, status, request_id)
    if code in (
        ErrorCode.AGENT_NOT_FOUND,
        ErrorCode.CONVERSATION_NOT_FOUND,
        ErrorCode.MESSAGE_NOT_FOUND,
        ErrorCode.OWNER_NOT_FOUND,
        ErrorCode.CLAIM_NOT_FOUND,
    ):
        return NotFoundError(body, status, request_id)
    if code == ErrorCode.GROUP_DELETED:
        return GroupDeletedError(body, status, request_id)
    if code == ErrorCode.INTERNAL_ERROR:
        return ServerError(body, status, request_id)

    # Fallback by HTTP status for codes that predate a subclass.
    if status == 401:
        return UnauthorizedError(body, status, request_id)
    if status == 403:
        return ForbiddenError(body, status, request_id)
    if status == 404:
        return NotFoundError(body, status, request_id)
    if status == 429:
        return RateLimitedError(body, status, retry_after_header, request_id)
    if status >= 500:
        return ServerError(body, status, request_id)
    return AgentChatError(body, status, request_id)
