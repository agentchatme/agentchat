"""Parse ``Retry-After`` response-header values per RFC 9110.

Accepts two forms:
  * ``delta-seconds`` — non-negative integer, interpreted as seconds from now.
  * ``HTTP-date`` — RFC 7231 date string (IMF-fixdate, RFC 850, asctime).

Returns a delay in **milliseconds** or ``None`` for missing / malformed input.

Lives in its own module to keep ``errors.py`` and ``_http.py`` decoupled —
both need this helper but must not import each other.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

_INTEGER_SECONDS = re.compile(r"^\d+$")
_HAS_ALPHA = re.compile(r"[A-Za-z]")


def parse_retry_after(raw: str | None) -> int | None:
    """Parse a ``Retry-After`` header value into milliseconds.

    Returns ``None`` for ``None``, empty, or unparseable input — the caller
    should then fall back to its own backoff schedule.
    """
    if raw is None:
        return None
    trimmed = raw.strip()
    if not trimmed:
        return None

    # Prefer the integer-seconds form. Rejecting anything with non-digit
    # characters (``60s``, ``1.5``, ``-1``) matches the JS SDK's guard
    # and avoids accidentally parsing those as dates below.
    if _INTEGER_SECONDS.match(trimmed):
        try:
            return int(trimmed) * 1000
        except ValueError:
            return None

    # HTTP-date formats per RFC 7231 all contain alphabetic characters
    # (day-of-week or month names). Requiring at least one alpha shields
    # us from ``parsedate_to_datetime`` liberally accepting numerics.
    if not _HAS_ALPHA.search(trimmed):
        return None

    try:
        dt = parsedate_to_datetime(trimmed)
    except (TypeError, ValueError):
        return None
    if dt is None:
        return None
    if dt.tzinfo is None:
        # parsedate_to_datetime returns naive datetime when the source has
        # no zone — treat as UTC per RFC 7231 §7.1.1.1.
        dt = dt.replace(tzinfo=timezone.utc)

    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    target_ms = int(dt.timestamp() * 1000)
    return max(0, target_ms - now_ms)
