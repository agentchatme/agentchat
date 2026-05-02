"""Tests for ``parse_retry_after``."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from email.utils import format_datetime

from agentchat import parse_retry_after


def test_integer_seconds() -> None:
    assert parse_retry_after("5") == 5_000
    assert parse_retry_after("60") == 60_000
    assert parse_retry_after("0") == 0


def test_missing_or_empty() -> None:
    assert parse_retry_after(None) is None
    assert parse_retry_after("") is None
    assert parse_retry_after("   ") is None


def test_malformed_numeric_forms() -> None:
    assert parse_retry_after("60s") is None
    assert parse_retry_after("1.5") is None
    assert parse_retry_after("-1") is None


def test_http_date_future_returns_positive_delta() -> None:
    future = datetime.now(timezone.utc) + timedelta(seconds=120)
    ms = parse_retry_after(format_datetime(future, usegmt=True))
    # Allow slop from process scheduling — the delta will be ~120s
    assert ms is not None
    assert 110_000 <= ms <= 125_000


def test_http_date_past_returns_zero() -> None:
    past = datetime.now(timezone.utc) - timedelta(seconds=10)
    assert parse_retry_after(format_datetime(past, usegmt=True)) == 0


def test_unparseable_string_returns_none() -> None:
    assert parse_retry_after("not-a-date") is None
