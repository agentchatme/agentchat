"""Tests for ``agentchat.errors.create_agentchat_error``.

Mirrors the TypeScript coverage: every mapped code, every status fallback,
plus the subclass hierarchy check.
"""

from __future__ import annotations

from agentchat.errors import (
    AgentChatError,
    BlockedError,
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


def test_rate_limited_header_wins() -> None:
    err = create_agentchat_error(
        {"code": "RATE_LIMITED", "message": "slow"},
        429,
        {"Retry-After": "12"},
    )
    assert isinstance(err, RateLimitedError)
    assert err.retry_after_ms == 12_000


def test_rate_limited_body_fallback() -> None:
    err = create_agentchat_error(
        {
            "code": "RATE_LIMITED",
            "message": "slow",
            "details": {"retry_after_ms": 4500},
        },
        429,
    )
    assert isinstance(err, RateLimitedError)
    assert err.retry_after_ms == 4500


def test_suspended_codes_map_to_suspended_error() -> None:
    for code in ("SUSPENDED", "AGENT_SUSPENDED"):
        err = create_agentchat_error({"code": code, "message": "x"}, 403)
        assert isinstance(err, SuspendedError)


def test_restricted_maps() -> None:
    err = create_agentchat_error({"code": "RESTRICTED", "message": "x"}, 403)
    assert isinstance(err, RestrictedError)


def test_recipient_backlogged_extracts_details() -> None:
    err = create_agentchat_error(
        {
            "code": "RECIPIENT_BACKLOGGED",
            "message": "full",
            "details": {"recipient_handle": "alice", "undelivered_count": 9800},
        },
        429,
    )
    assert isinstance(err, RecipientBackloggedError)
    assert err.recipient_handle == "alice"
    assert err.undelivered_count == 9800


def test_blocked_maps() -> None:
    assert isinstance(
        create_agentchat_error({"code": "BLOCKED", "message": "x"}, 403),
        BlockedError,
    )


def test_validation_maps() -> None:
    assert isinstance(
        create_agentchat_error({"code": "VALIDATION_ERROR", "message": "x"}, 400),
        ValidationError,
    )


def test_unauthorized_codes_map() -> None:
    for code in ("UNAUTHORIZED", "INVALID_API_KEY"):
        err = create_agentchat_error({"code": code, "message": "x"}, 401)
        assert isinstance(err, UnauthorizedError)


def test_forbidden_codes_map() -> None:
    for code in ("FORBIDDEN", "AGENT_PAUSED_BY_OWNER"):
        err = create_agentchat_error({"code": code, "message": "x"}, 403)
        assert isinstance(err, ForbiddenError)


def test_not_found_codes_map() -> None:
    for code in (
        "AGENT_NOT_FOUND",
        "CONVERSATION_NOT_FOUND",
        "MESSAGE_NOT_FOUND",
        "OWNER_NOT_FOUND",
        "CLAIM_NOT_FOUND",
    ):
        err = create_agentchat_error({"code": code, "message": "x"}, 404)
        assert isinstance(err, NotFoundError)


def test_group_deleted_extracts_details() -> None:
    err = create_agentchat_error(
        {
            "code": "GROUP_DELETED",
            "message": "gone",
            "details": {
                "group_id": "grp_1",
                "deleted_by_handle": "alice",
                "deleted_at": "2026-01-01T00:00:00Z",
            },
        },
        410,
    )
    assert isinstance(err, GroupDeletedError)
    assert err.group_id == "grp_1"
    assert err.deleted_by_handle == "alice"
    assert err.deleted_at == "2026-01-01T00:00:00Z"


def test_internal_error_maps() -> None:
    err = create_agentchat_error(
        {"code": "INTERNAL_ERROR", "message": "x"}, 500
    )
    assert isinstance(err, ServerError)


def test_unknown_code_falls_back_by_status() -> None:
    for status, cls in ((401, UnauthorizedError), (404, NotFoundError), (500, ServerError)):
        err = create_agentchat_error(
            {"code": "SOMETHING_NEW", "message": "x"}, status
        )
        assert isinstance(err, cls), (status, cls)
    # 418 is nobody's — catchall
    err = create_agentchat_error({"code": "SOMETHING_NEW", "message": "x"}, 418)
    assert type(err) is AgentChatError


def test_every_subclass_inherits_base() -> None:
    err = create_agentchat_error({"code": "SUSPENDED", "message": "x"}, 403)
    assert isinstance(err, AgentChatError)
    assert err.code == "SUSPENDED"
    assert err.status == 403


def test_request_id_threaded_from_headers() -> None:
    err = create_agentchat_error(
        {"code": "SUSPENDED", "message": "x"},
        403,
        {"x-request-id": "req_abc"},
    )
    assert err.request_id == "req_abc"
