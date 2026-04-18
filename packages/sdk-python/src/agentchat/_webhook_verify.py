"""Verify AgentChat webhook signatures.

Signature format (Stripe-compatible)::

    t=<unix-timestamp>,v1=<hex-hmac-sha256>

Or, for consumers that skip timestamping, a bare hex HMAC is accepted.

The ``v1`` scheme prefix lets us rotate to ``v2`` later without breaking
receivers that were pinned to the current shape.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, Literal, Optional, Union

_VerifyReason = Literal[
    "missing_signature",
    "malformed_signature",
    "timestamp_skew",
    "bad_signature",
    "malformed_payload",
]


class WebhookVerificationError(Exception):
    """Raised when webhook signature verification fails.

    ``reason`` is a stable machine-readable tag — always log it, never the
    raw body/signature/header (the header may leak the digest to attackers).
    """

    def __init__(self, reason: _VerifyReason, message: Optional[str] = None) -> None:
        super().__init__(message or reason)
        self.reason: _VerifyReason = reason


@dataclass
class VerifyWebhookOptions:
    """Options for :func:`verify_webhook`.

    payload:
        The raw request body exactly as received. Do **not** parse first —
        the signature is computed over bytes.
    signature:
        The value of the webhook signature header sent by AgentChat.
    secret:
        The signing secret you configured on the webhook endpoint.
    tolerance_seconds:
        Replay window. Default 300 (5 minutes) — the Stripe industry norm.
        Set to 0 to disable timestamp checking (not recommended in prod).
    now:
        Optional time source override for deterministic tests.
    """

    payload: Union[str, bytes]
    signature: Optional[str]
    secret: str
    tolerance_seconds: int = 300
    now: Optional[Callable[[], float]] = None


def verify_webhook(options: VerifyWebhookOptions) -> Dict[str, Any]:
    """Verify the signature and return the parsed JSON payload.

    Security-critical — read carefully before modifying:

    1. Parses the signature header in the ``t=…,v1=…`` form or as a bare hex.
    2. Computes HMAC-SHA256 over ``f"{t}.{body}"`` (or the raw body if no
       timestamp).
    3. Compares in constant time via :func:`hmac.compare_digest`.
    4. Rejects timestamps outside the tolerance window.

    On success returns the parsed payload as a dict. On any failure raises
    :class:`WebhookVerificationError` with ``reason`` set.
    """
    signature = options.signature
    if not signature:
        raise WebhookVerificationError("missing_signature")

    parsed = _parse_signature_header(signature)
    body_bytes = (
        options.payload.encode("utf-8")
        if isinstance(options.payload, str)
        else bytes(options.payload)
    )
    body_str = body_bytes.decode("utf-8", errors="replace")

    now_fn = options.now or time.time
    if parsed.timestamp is not None:
        if options.tolerance_seconds > 0:
            age_seconds = abs(now_fn() - parsed.timestamp)
            if age_seconds > options.tolerance_seconds:
                raise WebhookVerificationError("timestamp_skew")
        signed_message = f"{parsed.timestamp}.{body_str}".encode("utf-8")
    else:
        signed_message = body_bytes

    expected = hmac.new(
        options.secret.encode("utf-8"),
        signed_message,
        hashlib.sha256,
    ).hexdigest()

    if not hmac.compare_digest(expected, parsed.digest):
        raise WebhookVerificationError("bad_signature")

    try:
        payload = json.loads(body_str)
    except Exception as exc:  # noqa: BLE001
        raise WebhookVerificationError("malformed_payload") from exc

    if not isinstance(payload, dict):
        raise WebhookVerificationError("malformed_payload")
    return payload


@dataclass
class _ParsedSignature:
    timestamp: Optional[int]
    digest: str


def _parse_signature_header(header: str) -> _ParsedSignature:
    trimmed = header.strip()

    # Shape 1: key=value pairs, comma-separated. Order-insensitive; ignore unknowns.
    if "=" in trimmed:
        parts = trimmed.split(",")
        timestamp: Optional[int] = None
        digest: Optional[str] = None
        for part in parts:
            idx = part.find("=")
            if idx <= 0:
                continue
            key = part[:idx].strip()
            value = part[idx + 1 :].strip()
            if key == "t":
                try:
                    timestamp = int(float(value))
                except ValueError:
                    continue
            elif key == "v1":
                digest = value.lower()
        if not digest or not _is_hex(digest):
            raise WebhookVerificationError("malformed_signature")
        return _ParsedSignature(timestamp=timestamp, digest=digest)

    # Shape 2: bare hex digest.
    digest = trimmed.lower()
    if not _is_hex(digest):
        raise WebhookVerificationError("malformed_signature")
    return _ParsedSignature(timestamp=None, digest=digest)


def _is_hex(s: str) -> bool:
    if not s:
        return False
    return all(c in "0123456789abcdef" for c in s)
