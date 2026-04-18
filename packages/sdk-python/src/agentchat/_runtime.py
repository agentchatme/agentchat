"""Runtime detection + default ``User-Agent`` builder.

Mirrors the TypeScript SDK's ``defaultUserAgent`` format so server-side
log analyzers can parse SDK traffic uniformly regardless of language.

Format: ``agentchat-py/<sdk-version> <runtime>/<runtime-version>``
"""

from __future__ import annotations

import platform
import sys

from ._version import VERSION


def detect_runtime() -> str:
    """Return a ``<runtime>/<version>`` token identifying the Python runtime.

    Distinguishes CPython, PyPy, and other implementations. Used as the
    second segment of the default ``User-Agent`` header.
    """
    impl = platform.python_implementation().lower()  # cpython, pypy, etc.
    version = platform.python_version()  # e.g. "3.12.1"
    return f"{impl}/{version}"


def default_user_agent() -> str:
    """Default ``User-Agent`` emitted on every HTTP request.

    Format is deliberately close to Stripe / Twilio / OpenAI conventions
    so existing log pipelines parse it without adjustment.
    """
    return f"agentchat-py/{VERSION} {detect_runtime()}"


def platform_tag() -> str:
    """Coarse OS tag — useful for support tickets. Not part of the UA header."""
    return f"{platform.system().lower()}-{platform.machine().lower()}-py{sys.version_info.major}.{sys.version_info.minor}"
