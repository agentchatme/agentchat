"""Generator-based pagination helpers.

Two flavors share an identical interface:

- :func:`paginate` — sync generator; iterate with a ``for`` loop.
- :func:`apaginate` — async generator; iterate with ``async for``.

Both advance offset by the page size until the server reports all items
returned. Safe to ``break`` early.
"""

from __future__ import annotations

from typing import (
    AsyncGenerator,
    Awaitable,
    Callable,
    Generator,
    Generic,
    List,
    Optional,
    Protocol,
    TypeVar,
)

T = TypeVar("T")


class _Page(Protocol, Generic[T]):
    items: List[T]
    total: int
    limit: int
    offset: int


def paginate(
    fetch_page: Callable[[int, int], _Page[T]],
    *,
    page_size: int = 100,
    start: int = 0,
    max: Optional[int] = None,  # noqa: A002 — mirrors TS API
) -> Generator[T, None, None]:
    """Sync generator that walks every item across a limit/offset endpoint.

    ``fetch_page(offset, limit)`` must return an object with ``items`` (list)
    and ``total`` (int). The generator yields each item individually and
    stops once ``offset + items`` reaches ``total``.
    """
    offset = start
    yielded = 0
    cap = max if max is not None else float("inf")

    while yielded < cap:
        page = fetch_page(offset, page_size)
        items = list(page.items)
        if not items:
            return
        for item in items:
            if yielded >= cap:
                return
            yield item
            yielded += 1
        offset += len(items)
        if offset >= page.total:
            return


async def apaginate(
    fetch_page: Callable[[int, int], Awaitable[_Page[T]]],
    *,
    page_size: int = 100,
    start: int = 0,
    max: Optional[int] = None,  # noqa: A002 — mirrors TS API
) -> AsyncGenerator[T, None]:
    """Async generator counterpart to :func:`paginate`.

    ``fetch_page`` is awaited per page; the generator yields items lazily.
    """
    offset = start
    yielded = 0
    cap = max if max is not None else float("inf")

    while yielded < cap:
        page = await fetch_page(offset, page_size)
        items = list(page.items)
        if not items:
            return
        for item in items:
            if yielded >= cap:
                return
            yield item
            yielded += 1
        offset += len(items)
        if offset >= page.total:
            return
