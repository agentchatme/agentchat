"""Tests for ``verify_webhook``."""

from __future__ import annotations

import hashlib
import hmac
import json
import time

import pytest

from agentchat import VerifyWebhookOptions, WebhookVerificationError, verify_webhook

_SECRET = "whsec_test_1234"


def _sign(message: str) -> str:
    return hmac.new(_SECRET.encode(), message.encode(), hashlib.sha256).hexdigest()


def test_verifies_stripe_style_header() -> None:
    body = json.dumps(
        {
            "event": "message.new",
            "timestamp": "2026-01-01T00:00:00Z",
            "data": {"hello": "world"},
        }
    )
    ts = int(time.time())
    digest = _sign(f"{ts}.{body}")
    payload = verify_webhook(
        VerifyWebhookOptions(
            payload=body, signature=f"t={ts},v1={digest}", secret=_SECRET
        )
    )
    assert payload["event"] == "message.new"


def test_rejects_forged_signature() -> None:
    body = '{"event":"message.new","timestamp":"2026-01-01T00:00:00Z","data":{}}'
    ts = int(time.time())
    with pytest.raises(WebhookVerificationError) as exc_info:
        verify_webhook(
            VerifyWebhookOptions(
                payload=body,
                signature=f"t={ts},v1={'0' * 64}",
                secret=_SECRET,
            )
        )
    assert exc_info.value.reason == "bad_signature"


def test_rejects_stale_timestamp_beyond_tolerance() -> None:
    body = '{"event":"message.new","timestamp":"2025-01-01T00:00:00Z","data":{}}'
    ts = int(time.time()) - 3600
    digest = _sign(f"{ts}.{body}")
    with pytest.raises(WebhookVerificationError) as exc_info:
        verify_webhook(
            VerifyWebhookOptions(
                payload=body,
                signature=f"t={ts},v1={digest}",
                secret=_SECRET,
                tolerance_seconds=300,
            )
        )
    assert exc_info.value.reason == "timestamp_skew"


def test_accepts_stale_when_tolerance_is_zero() -> None:
    body = '{"event":"message.new","timestamp":"2025-01-01T00:00:00Z","data":{}}'
    ts = int(time.time()) - 3600
    digest = _sign(f"{ts}.{body}")
    payload = verify_webhook(
        VerifyWebhookOptions(
            payload=body,
            signature=f"t={ts},v1={digest}",
            secret=_SECRET,
            tolerance_seconds=0,
        )
    )
    assert payload["event"] == "message.new"


def test_rejects_missing_signature() -> None:
    with pytest.raises(WebhookVerificationError) as exc_info:
        verify_webhook(
            VerifyWebhookOptions(payload="{}", signature=None, secret=_SECRET)
        )
    assert exc_info.value.reason == "missing_signature"


def test_rejects_malformed_signature_header() -> None:
    with pytest.raises(WebhookVerificationError) as exc_info:
        verify_webhook(
            VerifyWebhookOptions(
                payload="{}",
                signature="t=1,v1=not-hex-just-words",
                secret=_SECRET,
            )
        )
    assert exc_info.value.reason == "malformed_signature"


def test_accepts_bare_hex_signature() -> None:
    body = '{"event":"message.new","timestamp":"2025-01-01T00:00:00Z","data":{}}'
    digest = _sign(body)
    payload = verify_webhook(
        VerifyWebhookOptions(payload=body, signature=digest, secret=_SECRET)
    )
    assert payload["event"] == "message.new"


def test_rejects_malformed_json_body_even_with_valid_signature() -> None:
    body = "not-json"
    ts = int(time.time())
    digest = _sign(f"{ts}.{body}")
    with pytest.raises(WebhookVerificationError) as exc_info:
        verify_webhook(
            VerifyWebhookOptions(
                payload=body,
                signature=f"t={ts},v1={digest}",
                secret=_SECRET,
            )
        )
    assert exc_info.value.reason == "malformed_payload"


def test_accepts_bytes_body() -> None:
    body_str = '{"event":"message.new","timestamp":"2025-01-01T00:00:00Z","data":{}}'
    body_bytes = body_str.encode()
    ts = int(time.time())
    digest = _sign(f"{ts}.{body_str}")
    payload = verify_webhook(
        VerifyWebhookOptions(
            payload=body_bytes,
            signature=f"t={ts},v1={digest}",
            secret=_SECRET,
        )
    )
    assert payload["event"] == "message.new"


def test_error_exposes_public_reason() -> None:
    try:
        verify_webhook(
            VerifyWebhookOptions(payload="{}", signature=None, secret=_SECRET)
        )
    except WebhookVerificationError as err:
        assert isinstance(err, WebhookVerificationError)
        assert err.reason == "missing_signature"
    else:
        pytest.fail("expected WebhookVerificationError")
