"""Tests for ``paginate`` / ``apaginate``."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

import pytest

from agentchat import apaginate, paginate


@dataclass
class _Page:
    items: list[Any]
    total: int
    limit: int
    offset: int


def _make_sync_fetcher(
    all_items: list[Any], counter: list[int]
) -> Callable[[int, int], _Page]:
    def fetch(offset: int, limit: int) -> _Page:
        counter[0] += 1
        return _Page(
            items=all_items[offset : offset + limit],
            total=len(all_items),
            limit=limit,
            offset=offset,
        )

    return fetch


def test_paginate_yields_all_items_across_pages() -> None:
    all_items = [{"id": i + 1} for i in range(7)]
    counter = [0]
    fetch = _make_sync_fetcher(all_items, counter)
    out = [item["id"] for item in paginate(fetch, page_size=3)]
    assert out == [1, 2, 3, 4, 5, 6, 7]
    assert counter[0] == 3  # 3 pages: 3 + 3 + 1


def test_paginate_stops_at_max() -> None:
    def fetch(offset: int, limit: int) -> _Page:
        return _Page(
            items=[{"id": offset + i + 1} for i in range(limit)],
            total=1_000_000,
            limit=limit,
            offset=offset,
        )

    out = [item["id"] for item in paginate(fetch, page_size=5, max=7)]
    assert out == [1, 2, 3, 4, 5, 6, 7]


def test_paginate_stops_on_empty_page() -> None:
    def fetch(offset: int, limit: int) -> _Page:
        items = [{"id": 1}] if offset == 0 else []
        return _Page(items=items, total=1, limit=limit, offset=offset)

    out = list(paginate(fetch))
    assert [x["id"] for x in out] == [1]


def test_paginate_custom_start_offset() -> None:
    def fetch(offset: int, limit: int) -> _Page:
        return _Page(
            items=[{"id": offset + i} for i in range(limit)],
            total=20,
            limit=limit,
            offset=offset,
        )

    out = [item["id"] for item in paginate(fetch, page_size=5, start=10)]
    assert out[0] == 10
    assert out[-1] == 19


def test_paginate_supports_early_break() -> None:
    def fetch(offset: int, limit: int) -> _Page:
        return _Page(
            items=[{"id": offset + i} for i in range(limit)],
            total=1_000_000,
            limit=limit,
            offset=offset,
        )

    out: list[int] = []
    for item in paginate(fetch, page_size=10):
        if item["id"] >= 3:
            break
        out.append(item["id"])
    assert out == [0, 1, 2]


# ───── Async counterpart ─────


@pytest.mark.asyncio
async def test_apaginate_yields_all_items_across_pages() -> None:
    all_items = [{"id": i + 1} for i in range(7)]
    calls = [0]

    async def fetch(offset: int, limit: int) -> _Page:
        calls[0] += 1
        return _Page(
            items=all_items[offset : offset + limit],
            total=len(all_items),
            limit=limit,
            offset=offset,
        )

    out = [item["id"] async for item in apaginate(fetch, page_size=3)]
    assert out == [1, 2, 3, 4, 5, 6, 7]
    assert calls[0] == 3


@pytest.mark.asyncio
async def test_apaginate_respects_max() -> None:
    async def fetch(offset: int, limit: int) -> _Page:
        return _Page(
            items=[{"id": offset + i + 1} for i in range(limit)],
            total=1_000_000,
            limit=limit,
            offset=offset,
        )

    out = [item["id"] async for item in apaginate(fetch, page_size=5, max=7)]
    assert out == [1, 2, 3, 4, 5, 6, 7]
