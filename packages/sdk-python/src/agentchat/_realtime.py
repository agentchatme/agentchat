"""Async realtime WebSocket client.

Mirrors the TypeScript ``RealtimeClient`` behavior:

- HELLO handshake with 4 s ack timeout (authenticates over wire, never URL)
- Per-conversation seq ordering with out-of-order buffering
- Gap detection with optional ``AsyncAgentChatClient``-backed recovery
- Jittered exponential reconnect, disposed flag, offline ``/sync`` drain

The client is async-only because Python's WebSocket story is asyncio-native.
Pair it with an :class:`~agentchat.AsyncAgentChatClient` for gap recovery and
auto-drain on reconnect.
"""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import json
import logging
import random
import time
from collections.abc import Awaitable, Coroutine
from dataclasses import dataclass, field
from typing import (
    TYPE_CHECKING,
    Any,
    Callable,
    Literal,
    Union,
)

from .errors import ConnectionError as _RealtimeConnectionError

if TYPE_CHECKING:
    from ._client import AsyncAgentChatClient


# ───────────────────────── Public type aliases ─────────────────────────

MessageHandler = Callable[[dict[str, Any]], Union[None, Awaitable[None]]]
"""Handler signature for WS frames. Receives the decoded JSON dict."""

ErrorHandler = Callable[[BaseException], Union[None, Awaitable[None]]]
"""Handler fired on every socket-level or protocol error."""

ConnectHandler = Callable[[], Union[None, Awaitable[None]]]
"""Handler fired once per successful ``hello.ok`` (initial + every reconnect)."""

DisconnectHandler = Callable[[dict[str, Any]], Union[None, Awaitable[None]]]
"""Handler fired on every close. Receives ``{code, reason, was_clean}``."""

GapReason = Literal[
    "gap_filled",
    "gap_fill_failed",
    "gap_fill_unavailable",
    "buffer_overflow",
]


@dataclass
class SequenceGapInfo:
    """Describes a detected per-conversation seq gap and its resolution."""

    conversation_id: str
    expected_seq: int
    buffered_seq: int | None
    gap_ms: int
    recovered: bool
    reason: GapReason


SequenceGapHandler = Callable[[SequenceGapInfo], Union[None, Awaitable[None]]]


@dataclass
class RealtimeOptions:
    """Configuration for :class:`RealtimeClient`."""

    api_key: str
    base_url: str = "wss://api.agentchat.me"
    reconnect: bool = True
    reconnect_interval_ms: int = 500
    max_reconnect_interval_ms: int = 30_000
    max_reconnect_attempts: int | None = None  # None → no limit
    client: AsyncAgentChatClient | None = None
    on_sequence_gap: SequenceGapHandler | None = None
    auto_drain_on_connect: bool | None = None  # None → True iff client set


# ───────────────────────── Internal constants ─────────────────────────

# Client-side ceiling on the HELLO ack wait. Must stay below the server
# HELLO_TIMEOUT_MS (5s) so our reconnect kicks in first.
_HELLO_ACK_TIMEOUT_S = 4.0

# Time we let a seq gap sit before issuing an explicit gap-fill. Two
# seconds is well below agent-loop perceptual floors and well above the
# drain↔live-fanout interleave window.
_GAP_FILL_WINDOW_S = 2.0

# Hard cap on per-conversation buffer before we force-drain and surface
# the incident. Realistic bursts stay well under this.
_MAX_BUFFERED_PER_CONVERSATION = 500

# Maximum rows requested in a single ``get_messages`` gap-fill.
_GAP_FILL_LIMIT = 200

# Sync drain page size sentinel — matches server default.
_SYNC_PAGE_SIZE = 100


@dataclass
class _OrderState:
    next_expected_seq: int | None = None
    buffer: dict[int, dict[str, Any]] = field(default_factory=dict)
    gap_task: asyncio.Task[None] | None = None
    gap_started_at: float | None = None
    gap_started_expected_seq: int | None = None
    gap_fill_in_flight: bool = False


# ───────────────────────── Client ─────────────────────────


class RealtimeClient:
    """WebSocket client with HELLO handshake, seq ordering, and reconnect.

    The class can be used in two construction styles:

    .. code-block:: python

        rt = RealtimeClient(api_key="sk_...", client=async_client)
        # — or —
        rt = RealtimeClient(RealtimeOptions(api_key="sk_...", client=...))

    It is also an async context manager::

        async with RealtimeClient(api_key="sk_...") as rt:
            rt.on("message.new", on_msg)
            await asyncio.sleep(3600)  # keep the loop alive
    """

    def __init__(
        self,
        options: RealtimeOptions | None = None,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        reconnect: bool | None = None,
        reconnect_interval_ms: int | None = None,
        max_reconnect_interval_ms: int | None = None,
        max_reconnect_attempts: int | None = None,
        client: AsyncAgentChatClient | None = None,
        on_sequence_gap: SequenceGapHandler | None = None,
        auto_drain_on_connect: bool | None = None,
        websocket_connect: Callable[..., Awaitable[Any]] | None = None,
    ) -> None:
        if options is None:
            if api_key is None:
                raise TypeError("RealtimeClient requires an api_key")
            options = RealtimeOptions(
                api_key=api_key,
                base_url=base_url if base_url is not None else "wss://api.agentchat.me",
                reconnect=reconnect if reconnect is not None else True,
                reconnect_interval_ms=(
                    reconnect_interval_ms if reconnect_interval_ms is not None else 500
                ),
                max_reconnect_interval_ms=(
                    max_reconnect_interval_ms
                    if max_reconnect_interval_ms is not None
                    else 30_000
                ),
                max_reconnect_attempts=max_reconnect_attempts,
                client=client,
                on_sequence_gap=on_sequence_gap,
                auto_drain_on_connect=auto_drain_on_connect,
            )

        if options.auto_drain_on_connect is None:
            options.auto_drain_on_connect = options.client is not None

        self._opts = options
        self._websocket_connect = websocket_connect

        self._ws: Any = None
        self._recv_task: asyncio.Task[None] | None = None
        self._reconnect_task: asyncio.Task[None] | None = None
        self._hello_ack_task: asyncio.Task[None] | None = None
        self._bg_tasks: set[asyncio.Task[Any]] = set()
        self._reconnect_attempts = 0
        self._authenticated = False
        self._disposed = False
        self._order_states: dict[str, _OrderState] = {}

        self._handlers: dict[str, set[MessageHandler]] = {}
        self._error_handlers: set[ErrorHandler] = set()
        self._connect_handlers: set[ConnectHandler] = set()
        self._disconnect_handlers: set[DisconnectHandler] = set()

    # ─── Context manager ─────────────────────────────────────────────

    async def __aenter__(self) -> RealtimeClient:
        await self.connect()
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.disconnect()

    # ─── connect ─────────────────────────────────────────────────────

    async def connect(self) -> None:
        """Open the WebSocket and send the HELLO frame.

        Returns once the HELLO has been transmitted — NOT after
        ``hello.ok``. Register :meth:`on_connect` to react to a fully
        authenticated session. Raises :class:`ConnectionError` if the
        socket fails to open or the ``websockets`` package is missing.
        """
        if self._disposed:
            raise _RealtimeConnectionError(
                "RealtimeClient has been disposed; create a new instance to reconnect."
            )

        connect_fn = self._resolve_connect_fn()

        url = f"{self._opts.base_url}/v1/ws"
        try:
            self._ws = await connect_fn(url)
        except Exception as err:
            error = _RealtimeConnectionError(f"WebSocket connection failed: {err}")
            await self._emit_error(error)
            self._schedule_reconnect()
            raise error from err

        self._authenticated = False

        try:
            await self._ws.send(
                json.dumps({"type": "hello", "api_key": self._opts.api_key})
            )
        except Exception as err:
            await self._emit_error(
                _RealtimeConnectionError(f"HELLO send failed: {err}")
            )
            return

        self._hello_ack_task = asyncio.create_task(self._hello_ack_watchdog())
        self._recv_task = asyncio.create_task(self._recv_loop())

    def _resolve_connect_fn(self) -> Callable[..., Awaitable[Any]]:
        if self._websocket_connect is not None:
            return self._websocket_connect
        try:
            from websockets.asyncio.client import connect as _ws_connect

            return _ws_connect
        except ImportError:
            pass
        try:
            from websockets import connect as _ws_connect_legacy

            return _ws_connect_legacy
        except ImportError as err:
            raise _RealtimeConnectionError(
                "The `websockets` package is required for the realtime client. "
                "Install it with `pip install websockets>=12`."
            ) from err

    async def _hello_ack_watchdog(self) -> None:
        try:
            await asyncio.sleep(_HELLO_ACK_TIMEOUT_S)
        except asyncio.CancelledError:
            return
        if self._authenticated or self._disposed:
            return
        await self._emit_error(_RealtimeConnectionError("HELLO ack timeout"))
        ws = self._ws
        if ws is not None:
            with contextlib.suppress(Exception):
                await ws.close(code=1008, reason="HELLO ack timeout")

    async def _recv_loop(self) -> None:
        ws = self._ws
        if ws is None:
            return
        try:
            async for raw in ws:
                try:
                    message = json.loads(raw)
                except (ValueError, TypeError):
                    continue
                if not isinstance(message, dict):
                    continue

                if not self._authenticated:
                    if message.get("type") == "hello.ok":
                        self._authenticated = True
                        self._reconnect_attempts = 0
                        if self._hello_ack_task is not None:
                            self._hello_ack_task.cancel()
                            self._hello_ack_task = None
                        await self._emit_connect()
                        if (
                            self._opts.auto_drain_on_connect
                            and self._opts.client is not None
                        ):
                            self._spawn(self.drain_offline_envelopes())
                    continue

                if message.get("type") == "message.new":
                    await self._process_ordered_message(message)
                    continue

                await self._dispatch(message)
        except asyncio.CancelledError:
            raise
        except Exception as err:
            await self._emit_error(
                _RealtimeConnectionError(f"WebSocket error: {err}")
            )
        finally:
            close_code = 0
            close_reason = ""
            if ws is not None:
                code_attr = getattr(ws, "close_code", None)
                reason_attr = getattr(ws, "close_reason", None)
                if isinstance(code_attr, int):
                    close_code = code_attr
                if isinstance(reason_attr, str):
                    close_reason = reason_attr

            if self._hello_ack_task is not None:
                self._hello_ack_task.cancel()
                self._hello_ack_task = None
            self._authenticated = False

            await self._emit_disconnect(
                {
                    "code": close_code,
                    "reason": close_reason,
                    "was_clean": close_code == 1000,
                }
            )

            self._reset_order_states()
            if not self._disposed:
                self._schedule_reconnect()

    # ─── Offline drain ───────────────────────────────────────────────

    async def drain_offline_envelopes(self) -> None:
        """Drain envelopes accumulated while the socket was disconnected.

        Routes each envelope through the same ``message.new`` ordering
        pipeline as live frames, then calls ``/v1/messages/sync/ack``.
        Safe to call multiple times within a connection cycle — the
        server's ack pointer only advances.
        """
        client = self._opts.client
        if client is None:
            return

        while True:
            try:
                batch = await client.sync()
            except Exception as err:
                await self._emit_error(
                    _RealtimeConnectionError(f"sync drain failed: {err}")
                )
                return

            envelopes = (
                batch.get("envelopes") if isinstance(batch, dict) else None
            ) or []
            if not isinstance(envelopes, list) or not envelopes:
                return

            highest_delivery_id = -1
            for env in envelopes:
                if not isinstance(env, dict):
                    continue
                did = env.get("delivery_id")
                if (
                    isinstance(did, int)
                    and not isinstance(did, bool)
                    and did > highest_delivery_id
                ):
                    highest_delivery_id = did
                msg = env.get("message")
                if not isinstance(msg, dict):
                    continue
                await self._process_ordered_message(
                    {"type": "message.new", "payload": msg}
                )

            if highest_delivery_id >= 0:
                try:
                    await client.sync_ack(highest_delivery_id)
                except Exception as err:
                    await self._emit_error(
                        _RealtimeConnectionError(f"sync ack failed: {err}")
                    )
                    return

            if len(envelopes) < _SYNC_PAGE_SIZE:
                return

    # ─── Reconnect ───────────────────────────────────────────────────

    def _schedule_reconnect(self) -> None:
        if self._disposed or not self._opts.reconnect:
            return
        max_attempts = self._opts.max_reconnect_attempts
        if max_attempts is not None and self._reconnect_attempts >= max_attempts:
            return
        if self._reconnect_task is not None and not self._reconnect_task.done():
            return

        self._reconnect_attempts += 1
        delay_s = self._compute_reconnect_delay_ms(self._reconnect_attempts) / 1000.0
        self._reconnect_task = asyncio.create_task(self._reconnect_after(delay_s))

    async def _reconnect_after(self, delay_s: float) -> None:
        try:
            await asyncio.sleep(delay_s)
        except asyncio.CancelledError:
            return
        self._reconnect_task = None
        if self._disposed:
            return
        try:
            await self.connect()
        except Exception as err:
            await self._emit_error(
                err
                if isinstance(err, _RealtimeConnectionError)
                else _RealtimeConnectionError(str(err))
            )

    def _compute_reconnect_delay_ms(self, attempt: int) -> int:
        exp = self._opts.reconnect_interval_ms * (2 ** min(attempt - 1, 10))
        capped = min(exp, self._opts.max_reconnect_interval_ms)
        # ±25% jitter defeats thundering-herd reconnect.
        jitter = 0.75 + random.random() * 0.5
        return max(0, int(capped * jitter))

    # ─── Handler registration ────────────────────────────────────────

    def on(self, event: str, handler: MessageHandler) -> Callable[[], None]:
        """Register a handler for a server event. Returns an unsubscribe fn."""
        handlers = self._handlers.setdefault(event, set())
        handlers.add(handler)

        def off() -> None:
            hs = self._handlers.get(event)
            if hs is None:
                return
            hs.discard(handler)
            if not hs:
                self._handlers.pop(event, None)

        return off

    def on_error(self, handler: ErrorHandler) -> Callable[[], None]:
        self._error_handlers.add(handler)
        return lambda: self._error_handlers.discard(handler)

    def on_connect(self, handler: ConnectHandler) -> Callable[[], None]:
        """Fires each time the HELLO handshake completes (initial + reconnects)."""
        self._connect_handlers.add(handler)
        return lambda: self._connect_handlers.discard(handler)

    def on_disconnect(self, handler: DisconnectHandler) -> Callable[[], None]:
        """Fires on every socket close, regardless of reason."""
        self._disconnect_handlers.add(handler)
        return lambda: self._disconnect_handlers.discard(handler)

    async def send(self, message: dict[str, Any]) -> None:
        """Send a client-initiated frame (e.g. ``typing.start``)."""
        if self._ws is None or not self._authenticated:
            raise _RealtimeConnectionError("WebSocket is not connected")
        try:
            await self._ws.send(json.dumps(message))
        except Exception as err:
            raise _RealtimeConnectionError(f"send failed: {err}") from err

    @property
    def is_connected(self) -> bool:
        return bool(self._authenticated and self._ws is not None)

    async def disconnect(self) -> None:
        """Close the socket, disable reconnect, and release all handlers.

        After this, :meth:`connect` raises — create a fresh
        :class:`RealtimeClient` if you need to reopen.
        """
        self._disposed = True
        self._opts.reconnect = False

        if self._reconnect_task is not None:
            self._reconnect_task.cancel()
            self._reconnect_task = None
        if self._hello_ack_task is not None:
            self._hello_ack_task.cancel()
            self._hello_ack_task = None

        await self._drain_all_pending_for_shutdown()

        ws = self._ws
        self._ws = None
        if ws is not None:
            with contextlib.suppress(Exception):
                await ws.close()

        if self._recv_task is not None:
            with contextlib.suppress(asyncio.CancelledError, asyncio.TimeoutError, Exception):
                await asyncio.wait_for(self._recv_task, timeout=1.0)
            self._recv_task = None

        for task in list(self._bg_tasks):
            task.cancel()
        self._bg_tasks.clear()

        self._authenticated = False
        self._handlers.clear()
        self._error_handlers.clear()
        self._connect_handlers.clear()
        self._disconnect_handlers.clear()

    # ─── Dispatch ────────────────────────────────────────────────────

    async def _emit_error(self, error: BaseException) -> None:
        for h in list(self._error_handlers):
            await _invoke(h, error)

    async def _emit_connect(self) -> None:
        for h in list(self._connect_handlers):
            await _invoke0(h)

    async def _emit_disconnect(self, info: dict[str, Any]) -> None:
        for h in list(self._disconnect_handlers):
            await _invoke(h, info)

    async def _dispatch(self, message: dict[str, Any]) -> None:
        event = message.get("type")
        if not isinstance(event, str):
            return
        handlers = self._handlers.get(event)
        if not handlers:
            return
        for h in list(handlers):
            await _invoke(h, message)

    def _spawn(self, coro: Coroutine[Any, Any, Any]) -> None:
        task: asyncio.Task[Any] = asyncio.create_task(coro)
        self._bg_tasks.add(task)
        task.add_done_callback(self._bg_tasks.discard)

    # ─── Per-conversation seq ordering ───────────────────────────────
    #
    # Invariant: for any conversation_id, handlers see message.new envelopes
    # in strict seq-ascending order, no gaps and no repeats (modulo the
    # gap-fill-failed path, where we surface ``recovered=False`` and
    # advance the cursor past the hole).

    async def _process_ordered_message(self, message: dict[str, Any]) -> None:
        payload = message.get("payload")
        if not isinstance(payload, dict):
            await self._dispatch(message)
            return
        conversation_id = payload.get("conversation_id")
        if not isinstance(conversation_id, str):
            await self._dispatch(message)
            return

        seq = _extract_seq(message)
        if seq is None:
            await self._dispatch(message)
            return

        state = self._order_states.get(conversation_id)
        if state is None:
            state = _OrderState()
            self._order_states[conversation_id] = state

        # First arrival for this conversation in this connection — anchor.
        if state.next_expected_seq is None:
            state.next_expected_seq = seq + 1
            await self._dispatch(message)
            return

        if seq < state.next_expected_seq:
            return  # duplicate — drain↔live race or server double-publish

        if seq == state.next_expected_seq:
            await self._dispatch(message)
            state.next_expected_seq = seq + 1
            await self._drain_consecutive(conversation_id, state)
            self._maybe_clear_gap_timer(state)
            self._cleanup_if_idle(conversation_id, state)
            return

        # seq > next_expected_seq — out of order. Buffer + arm gap timer.
        state.buffer[seq] = message

        if len(state.buffer) > _MAX_BUFFERED_PER_CONVERSATION:
            await self._resolve_gap(
                conversation_id,
                state,
                recovered=False,
                reason="buffer_overflow",
                buffered_seq=_min_buffered_seq(state),
            )
            return

        if state.gap_task is None:
            state.gap_started_at = time.monotonic()
            state.gap_started_expected_seq = state.next_expected_seq
            state.gap_task = asyncio.create_task(self._gap_timer(conversation_id))

    async def _gap_timer(self, conversation_id: str) -> None:
        try:
            await asyncio.sleep(_GAP_FILL_WINDOW_S)
        except asyncio.CancelledError:
            return
        await self._handle_gap_timer(conversation_id)

    async def _handle_gap_timer(self, conversation_id: str) -> None:
        state = self._order_states.get(conversation_id)
        if state is None:
            return
        state.gap_task = None

        # Race: missing seq may have arrived between timer firing and now.
        if not state.buffer:
            self._cleanup_if_idle(conversation_id, state)
            return

        expected_seq = state.next_expected_seq
        if expected_seq is None:
            return  # defensive

        if self._opts.client is None:
            await self._resolve_gap(
                conversation_id,
                state,
                recovered=False,
                reason="gap_fill_unavailable",
                buffered_seq=_min_buffered_seq(state),
            )
            return

        if state.gap_fill_in_flight:
            return
        state.gap_fill_in_flight = True

        fetched: list[dict[str, Any]] = []
        fill_error = False
        try:
            # ``after_seq`` is exclusive, so subtract 1 to include ``expected_seq``.
            fetched = await self._opts.client.get_messages(
                conversation_id,
                after_seq=expected_seq - 1,
                limit=_GAP_FILL_LIMIT,
            )
        except Exception:
            fill_error = True
        finally:
            state.gap_fill_in_flight = False

        # State may have been reset (disconnect during the await).
        state_now = self._order_states.get(conversation_id)
        if state_now is not state:
            return

        if fill_error:
            await self._resolve_gap(
                conversation_id,
                state,
                recovered=False,
                reason="gap_fill_failed",
                buffered_seq=_min_buffered_seq(state),
            )
            return

        for row in fetched or []:
            if not isinstance(row, dict):
                continue
            row_seq = row.get("seq")
            if not isinstance(row_seq, int) or isinstance(row_seq, bool):
                continue
            if row_seq < expected_seq:
                continue
            if row_seq in state.buffer:
                continue
            state.buffer[row_seq] = {"type": "message.new", "payload": row}

        drained = await self._drain_consecutive(conversation_id, state)
        if drained:
            await self._resolve_gap(
                conversation_id,
                state,
                recovered=True,
                reason="gap_filled",
                buffered_seq=None,
            )
        else:
            await self._resolve_gap(
                conversation_id,
                state,
                recovered=False,
                reason="gap_fill_failed",
                buffered_seq=_min_buffered_seq(state),
            )

    async def _drain_consecutive(
        self, conversation_id: str, state: _OrderState
    ) -> bool:
        if state.next_expected_seq is None:
            return False
        drained = False
        while state.next_expected_seq in state.buffer:
            msg = state.buffer.pop(state.next_expected_seq)
            await self._dispatch(msg)
            state.next_expected_seq += 1
            drained = True
        if drained:
            self._cleanup_if_idle(conversation_id, state)
        return drained

    async def _resolve_gap(
        self,
        conversation_id: str,
        state: _OrderState,
        *,
        recovered: bool,
        reason: GapReason,
        buffered_seq: int | None,
    ) -> None:
        if state.gap_started_expected_seq is not None:
            expected_seq = state.gap_started_expected_seq
        elif state.next_expected_seq is not None:
            expected_seq = state.next_expected_seq
        else:
            expected_seq = 0
        gap_ms = (
            int((time.monotonic() - state.gap_started_at) * 1000)
            if state.gap_started_at is not None
            else 0
        )

        seqs = sorted(state.buffer.keys())
        if state.next_expected_seq is not None:
            highest_dispatched = state.next_expected_seq - 1
        else:
            highest_dispatched = -1
        for s in seqs:
            await self._dispatch(state.buffer[s])
            if s > highest_dispatched:
                highest_dispatched = s
        state.buffer.clear()
        if highest_dispatched >= 0:
            state.next_expected_seq = highest_dispatched + 1

        if state.gap_task is not None:
            state.gap_task.cancel()
            state.gap_task = None
        state.gap_started_at = None
        state.gap_started_expected_seq = None

        if self._opts.on_sequence_gap is not None:
            info = SequenceGapInfo(
                conversation_id=conversation_id,
                expected_seq=expected_seq,
                buffered_seq=buffered_seq,
                gap_ms=gap_ms,
                recovered=recovered,
                reason=reason,
            )
            await _invoke(self._opts.on_sequence_gap, info)

        self._cleanup_if_idle(conversation_id, state)

    def _maybe_clear_gap_timer(self, state: _OrderState) -> None:
        if state.gap_task is not None and not state.buffer:
            state.gap_task.cancel()
            state.gap_task = None
            state.gap_started_at = None
            state.gap_started_expected_seq = None

    def _cleanup_if_idle(self, conversation_id: str, state: _OrderState) -> None:
        if (
            not state.buffer
            and state.gap_task is None
            and not state.gap_fill_in_flight
        ):
            self._order_states.pop(conversation_id, None)

    def _reset_order_states(self) -> None:
        for state in self._order_states.values():
            if state.gap_task is not None:
                state.gap_task.cancel()
        self._order_states.clear()

    async def _drain_all_pending_for_shutdown(self) -> None:
        for conversation_id, state in list(self._order_states.items()):
            if state.gap_task is not None:
                state.gap_task.cancel()
                state.gap_task = None
            if not state.buffer:
                continue
            seqs = sorted(state.buffer.keys())
            for s in seqs:
                await self._dispatch(state.buffer[s])
            state.buffer.clear()
            if self._opts.on_sequence_gap is not None:
                if state.gap_started_expected_seq is not None:
                    expected_seq = state.gap_started_expected_seq
                elif state.next_expected_seq is not None:
                    expected_seq = state.next_expected_seq
                else:
                    expected_seq = 0
                info = SequenceGapInfo(
                    conversation_id=conversation_id,
                    expected_seq=expected_seq,
                    buffered_seq=seqs[0] if seqs else None,
                    gap_ms=(
                        int((time.monotonic() - state.gap_started_at) * 1000)
                        if state.gap_started_at is not None
                        else 0
                    ),
                    recovered=False,
                    reason="gap_fill_unavailable",
                )
                await _invoke(self._opts.on_sequence_gap, info)
        self._order_states.clear()


# ───────────────────────── Module helpers ─────────────────────────


_log = logging.getLogger("agentchat.realtime")


async def _invoke(handler: Any, arg: Any) -> None:
    try:
        result = handler(arg)
        if inspect.isawaitable(result):
            await result
    except Exception:
        # User-hook exceptions must not break the recv/reconnect loop, but
        # they shouldn't vanish silently either — surface via logger so apps
        # can route them through their normal observability stack.
        _log.warning("realtime handler raised", exc_info=True)


async def _invoke0(handler: Any) -> None:
    try:
        result = handler()
        if inspect.isawaitable(result):
            await result
    except Exception:
        _log.warning("realtime handler raised", exc_info=True)


def _extract_seq(message: dict[str, Any]) -> int | None:
    payload = message.get("payload")
    if not isinstance(payload, dict):
        return None
    seq = payload.get("seq")
    if isinstance(seq, int) and not isinstance(seq, bool):
        return seq
    return None


def _min_buffered_seq(state: _OrderState) -> int | None:
    if not state.buffer:
        return None
    return min(state.buffer.keys())


__all__ = [
    "ConnectHandler",
    "DisconnectHandler",
    "ErrorHandler",
    "MessageHandler",
    "RealtimeClient",
    "RealtimeOptions",
    "SequenceGapHandler",
    "SequenceGapInfo",
]
