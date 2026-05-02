"""Shared pytest fixtures."""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _quiet_httpx_caplog(caplog: pytest.LogCaptureFixture) -> None:
    # Silence httpx/httpcore DEBUG spam in test output without affecting
    # the ability for individual tests to opt in to caplog assertions.
    import logging

    for name in ("httpx", "httpcore", "websockets"):
        logging.getLogger(name).setLevel(logging.WARNING)
