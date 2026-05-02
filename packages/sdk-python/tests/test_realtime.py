"""Tests for :class:`agentchat.RealtimeClient`.

Covers the HELLO handshake, per-conversation seq ordering, gap recovery,
reconnect behavior, the disposed flag, and the offline drain. The
WebSocket library is stubbed via the ``websocket_connect`` constructor
hook so no real sockets are opened.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from agentchat import ConnectionError as AgentChatConnectionError
from agentchat import RealtimeClient, SequenceGapInfo

# ─────────────── Mock infrastructure ───────────────


class MockWebSocket:
    """In-memory WebSocket stand-in.

    Tests push framed JSON strings into ``inbox`` (via :meth:`push`); the
    realtime client sees them through ``async for`` exactly as it would
    from a real socket. :meth:`close` ends the iteration.
    """

    def __init__(self) -> None:
        self._inbox: asyncio.Queue[str | None] = asyncio.Queue()
        self.sent: list[str] = []
        self.close_code: int | None = None
        self.close_reason: str = ""
        self.closed = False

    async def send(self, data: str) -> None:
        self.sent.append(data)

    async def close(self, code: int = 1000, reason: str = "") -> None:
        if self.closed:
            return
        self.closed = True
        self.close_code = code
        self.close_reason = reason
        await self._inbox.put(None)

    def __aiter__(self) -> MockWebSocket:
        return self

    async def __anext__(self) -> str:
        msg = await self._inbox.get()
        if msg is None:
            raise StopAsyncIteration
        return msg

    async def push(self, msg: Any) -> None:
        framed = msg if isinstance(msg, str) else json.dumps(msg)
        await self._inbox.put(framed)


class MockAsyncClient:
    """Minimal stand-in for ``AsyncAgentChatClient`` — just the methods the
    realtime client calls during gap recovery and the offline drain."""

    def __init__(
        self,
        *,
        get_messages_result: list[dict[str, Any]] | None = None,
        get_messages_raises: bool = False,
        sync_batches: list[dict[str, Any]] | None = None,
    ) -> None:
        self._get_messages_result = get_messages_result or []
        self._get_messages_raises = get_messages_raises
        self._sync_batches = list(sync_batches or [])
        self.get_messages_calls: list[tuple[str, dict[str, Any]]] = []
        self.sync_calls = 0
        self.sync_ack_calls: list[int] = []

    async def get_messages(
        self, conversation_id: str, **kwargs: Any
    ) -> list[dict[str, Any]]:
        self.get_messages_calls.append((conversation_id, kwargs))
        if self._get_messages_raises:
            raise RuntimeError("boom")
        return self._get_messages_result

    async def sync(self, **_kwargs: Any) -> dict[str, Any]:
        self.sync_calls += 1
        if not self._sync_batches:
            return {"envelopes": []}
        return self._sync_batches.pop(0)

    async def sync_ack(self, last_delivery_id: int, **_kwargs: Any) -> dict[str, Any]:
        self.sync_ack_calls.append(last_delivery_id)
        return {}


def _make_client(
    *,
    ws: MockWebSocket | None = None,
    client: MockAsyncClient | None = None,
    reconnect: bool = False,
    reconnect_interval_ms: int = 10,
    max_reconnect_interval_ms: int = 20,
    auto_drain_on_connect: bool | None = None,
    **opts: Any,
) -> tuple[RealtimeClient, MockWebSocket]:
    sock = ws if ws is not None else MockWebSocket()

    async def fake_connect(_url: str, **_kw: Any) -> MockWebSocket:
        return sock

    rt = RealtimeClient(
        api_key="sk_test",
        client=client,  # type: ignore[arg-type]
        reconnect=reconnect,
        reconnect_interval_ms=reconnect_interval_ms,
        max_reconnect_interval_ms=max_reconnect_interval_ms,
        auto_drain_on_connect=auto_drain_on_connect,
        websocket_connect=fake_connect,
        **opts,
    )
    return rt, sock


async def _settle() -> None:
    """Yield the event loop a few times so queued coroutines run."""
    for _ in range(5):
        await asyncio.sleep(0)


# ─────────────── Handshake ───────────────


@pytest.mark.asyncio
async def test_connect_sends_hello_frame() -> None:
    rt, ws = _make_client()
    try:
        await rt.connect()
        await _settle()
        assert len(ws.sent) == 1
        sent = json.loads(ws.sent[0])
        assert sent == {"type": "hello", "api_key": "sk_test"}
    finally:
        await rt.disconnect()


@pytest.mark.asyncio
async def test_hello_ok_fires_on_connect_and_is_not_dispatched() -> None:
    rt, ws = _make_client()
    connected = [0]
    msg_handler_called = [0]
    rt.on_connect(lambda: connected.__setitem__(0, connected[0] + 1))
    rt.on("hello.ok", lambda _m: msg_handler_called.__setitem__(0, msg_handler_called[0] + 1))
    try:
        await rt.connect()
        await _settle()
        await ws.push({"type": "hello.ok"})
        await _settle()
        assert connected[0] == 1
        assert msg_handler_called[0] == 0
        assert rt.is_connected is True
    finally:
        await rt.disconnect()


@pytest.mark.asyncio
async def test_pre_ack_frames_are_dropped() -> None:
    rt, ws = _make_client()
    msgs: list[dict[str, Any]] = []
    rt.on("message.new", lambda m: msgs.append(m))
    try:
        await rt.connect()
        await _settle()
        # Before hello.ok — must be ignored by the client.
        await ws.push(
            {"type": "message.new", "payload": {"conversation_id": "c1", "seq": 1}}
        )
        await _settle()
        assert msgs == []
    finally:
        await rt.disconnect()


@pytest.mark.asyncio
async def test_non_message_event_dispatches() -> None:
    rt, ws = _make_client()
    events: list[dict[str, Any]] = []
    rt.on("presence.update", lambda m: events.append(m))
    try:
        await rt.connect()
        await _settle()
        await ws.push({"type": "hello.ok"})
        await _settle()
        payload = {"handle": "@alice", "status": "online"}
        await ws.push({"type": "presence.update", "payload": payload})
        await _settle()
        assert len(events) == 1
        assert events[0]["payload"] == payload
    finally:
        await rt.disconnect()


# ─────────────── Per-conversation seq ordering ───────────────


@pytest.mark.asyncio
async def test_message_new_dispatches_in_order() -> None:
    rt, ws = _make_client()
    seqs: list[int] = []
    rt.on("message.new", lambda m: seqs.append(m["payload"]["seq"]))
    try:
        await rt.connect()
        await _settle()
        await ws.push({"type": "hello.ok"})
        await _settle()
        for seq in (1, 2, 3):
            await ws.push(
                {"type": "message.new", "payload": {"conversation_id": "c1", "seq": seq}}
            )
        await _settle()
        assert seqs == [1, 2, 3]
    finally:
        await rt.disconnect()


@pytest.mark.asyncio
async def test_duplicate_seq_is_dropped_while_state_active() -> None:
    # Dedup only applies while the per-conversation state is live — i.e. a
    # later-seq message is buffered and waiting. Once the buffer drains
    # and the state is cleaned up, a reappearing seq looks like a first
    # arrival on a fresh anchor (and is rare in practice because the
    # server de-dups upstream).
    rt, ws = _make_client()
    seqs: list[int] = []
    rt.on("message.new", lambda m: seqs.append(m["payload"]["seq"]))
    try:
        await rt.connect()
        await _settle()
        await ws.push({"type": "hello.ok"})
        await _settle()
        # Anchor at 1 → next_expected_seq = 2.
        await ws.push({"type": "message.new", "payload": {"conversation_id": "c1", "seq": 1}})
        # Buffer 3 — state stays live waiting on the missing 2.
        await ws.push({"type": "message.new", "payload": {"conversation_id": "c1", "seq": 3}})
        # Duplicate of 1 — seq < next_expected_seq, must be dropped.
        await ws.push({"type": "message.new", "payload": {"conversation_id": "c1", "seq": 1}})
        # Now 2 arrives → drain 2, 3 in order.
        await ws.push({"type": "message.new", "payload": {"conversation_id": "c1", "seq": 2}})
        await _settle()
        assert seqs == [1, 2, 3]
    finally:
        await rt.disconnect()


@pytest.mark.asyncio
async def test_out_of_order_drains_when_missing_arrives() -> None:
    rt, ws = _make_client()
    seqs: list[int] = []
    rt.on("message.new", lambda m: seqs.append(m["payload"]["seq"]))
    try:
        await rt.connect()
        await _settle()
        await ws.push({"type": "hello.ok"})
        await _settle()
        # Anchor at 1 (next_expected_seq becomes 2).
        await ws.push({"type": "message.new", "payload": {"conversation_id": "c1", "seq": 1}})
        # Buffer 3 and 4 waiting for 2.
        await ws.push({"type": "message.new", "payload": {"conversation_id": "c1", "seq": 3}})
        await ws.push({"type": "message.new", "payload": {"conversation_id": "c1", "seq": 4}})
        await _settle()
        assert seqs == [1]
        # 2 arrives — drain 2, 3, 4 in order.
        await ws.push({"type": "message.new", "payload": {"conversation_id": "c1", "seq": 2}})
        await _settle()
        assert seqs == [1, 2, 3, 4]
    finally:
        await rt.disconnect()


@pytest.mark.asyncio
async def test_independent_ordering_per_conversation() -> None:
    rt, ws = _make_client()
    dispatched: list[dict[str, Any]] = []
    rt.on("message.new", lambda m: dispatched.append(m["payload"]))
    try:
        await rt.connect()
        await _settle()
        await ws.push({"type": "hello.ok"})
        await _settle()
        # Interleave two conversations — each anchors on its own first seq.
        await ws.push({"type": "message.new", "payload": {"conversation_id": "c1", "seq": 100}})
        await ws.push({"type": "message.new", "payload": {"conversation_id": "c2", "seq": 5}})
        await ws.push({"type": "message.new", "payload": {"conversation_id": "c1", "seq": 101}})
        await ws.push({"type": "message.new", "payload": {"conversation_id": "c2", "seq": 6}})
        await _settle()
        assert [p["conversation_id"] for p in dispatched] == ["c1", "c2", "c1", "c2"]
    finally:
        await rt.disconnect()


@pytest.mark.asyncio
async def test_message_without_seq_passes_through() -> None:
    rt, ws = _make_client()
    dispatched: list[dict[str, Any]] = []
    rt.on("message.new", lambda m: dispatched.append(m))
    try:
        await rt.connect()
        await _settle()
        await ws.push({"type": "hello.ok"})
        await _settle()
        # No seq — system notice reusing the message.new shape.
        await ws.push(
            {"type": "message.new", "payload": {"conversation_id": "c1", "body": "x"}}
        )
        await _settle()
        assert len(dispatched) == 1
    finally:
        await rt.disconnect()


# ─────────────── Gap recovery ───────────────


@pytest.mark.asyncio
async def test_gap_fill_unavailable_without_client(monkeypatch: pytest.MonkeyPatch) -> None:
    # Shrink the gap timer so the test finishes quickly.
    monkeypatch.setattr("agentchat._realtime._GAP_FILL_WINDOW_S", 0.05)
    rt, ws = _make_client(on_sequence_gap=lambda info: gaps.append(info))
    gaps: list[SequenceGapInfo] = []
    seqs: list[int] = []
    rt.on("message.new", lambda m: seqs.append(m["payload"]["seq"]))
    try:
        await rt.connect()
        await _settle()
        await ws.push({"type": "hello.ok"})
        await _settle()
        # Anchor at 1 → next_expected = 2.
        await ws.push({"type": "message.new", "payload": {"conversation_id": "c1", "seq": 1}})
        # 3 arrives — 2 is missing; no client means no recovery path.
        await ws.push({"type": "message.new", "payload": {"conversation_id": "c1", "seq": 3}})
        await _settle()
        # Let the gap timer fire.
        await asyncio.sleep(0.12)
        await _settle()
        assert len(gaps) == 1
        assert gaps[0].recovered is False
        assert gaps[0].reason == "gap_fill_unavailable"
        # Even unrecovered, the buffered 3 should still have been dispatched.
        assert 3 in seqs
    finally:
        await rt.disconnect()


@pytest.mark.asyncio
async def test_gap_fill_success_via_get_messages(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("agentchat._realtime._GAP_FILL_WINDOW_S", 0.05)
    recovered_row = {"conversation_id": "c1", "seq": 2, "body": "filled"}
    mock_api = MockAsyncClient(get_messages_result=[recovered_row])
    rt, ws = _make_client(client=mock_api, on_sequence_gap=lambda info: gaps.append(info))
    gaps: list[SequenceGapInfo] = []
    seqs: list[int] = []
    rt.on("message.new", lambda m: seqs.append(m["payload"]["seq"]))
    try:
        await rt.connect()
        await _settle()
        await ws.push({"type": "hello.ok"})
        await _settle()
        await ws.push({"type": "message.new", "payload": {"conversation_id": "c1", "seq": 1}})
        # Skip 2, push 3.
        await ws.push({"type": "message.new", "payload": {"conversation_id": "c1", "seq": 3}})
        await asyncio.sleep(0.12)
        await _settle()
        assert len(gaps) == 1
        assert gaps[0].recovered is True
        assert gaps[0].reason == "gap_filled"
        assert seqs == [1, 2, 3]
        # Called get_messages with after_seq=1 (expected_seq - 1).
        assert len(mock_api.get_messages_calls) == 1
        _conv, kw = mock_api.get_messages_calls[0]
        assert kw["after_seq"] == 1
    finally:
        await rt.disconnect()


@pytest.mark.asyncio
async def test_gap_fill_failure_surfaces_recovered_false(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("agentchat._realtime._GAP_FILL_WINDOW_S", 0.05)
    mock_api = MockAsyncClient(get_messages_raises=True)
    gaps: list[SequenceGapInfo] = []
    rt, ws = _make_client(client=mock_api, on_sequence_gap=lambda info: gaps.append(info))
    try:
        await rt.connect()
        await _settle()
        await ws.push({"type": "hello.ok"})
        await _settle()
        await ws.push({"type": "message.new", "payload": {"conversation_id": "c1", "seq": 1}})
        await ws.push({"type": "message.new", "payload": {"conversation_id": "c1", "seq": 3}})
        await asyncio.sleep(0.12)
        await _settle()
        assert len(gaps) == 1
        assert gaps[0].recovered is False
        assert gaps[0].reason == "gap_fill_failed"
    finally:
        await rt.disconnect()


@pytest.mark.asyncio
async def test_buffer_overflow_triggers_force_drain(monkeypatch: pytest.MonkeyPatch) -> None:
    # Shrink the overflow cap so the test can trip it without thousands of pushes.
    monkeypatch.setattr("agentchat._realtime._MAX_BUFFERED_PER_CONVERSATION", 4)
    monkeypatch.setattr("agentchat._realtime._GAP_FILL_WINDOW_S", 30.0)  # timer won't fire
    gaps: list[SequenceGapInfo] = []
    rt, ws = _make_client(on_sequence_gap=lambda info: gaps.append(info))
    try:
        await rt.connect()
        await _settle()
        await ws.push({"type": "hello.ok"})
        await _settle()
        await ws.push({"type": "message.new", "payload": {"conversation_id": "c1", "seq": 1}})
        # Leave 2 missing, queue 3..7 to exceed cap (4).
        for seq in (3, 4, 5, 6, 7):
            await ws.push(
                {"type": "message.new", "payload": {"conversation_id": "c1", "seq": seq}}
            )
        await _settle()
        assert len(gaps) == 1
        assert gaps[0].reason == "buffer_overflow"
    finally:
        await rt.disconnect()


# ─────────────── Reconnect & disposed flag ───────────────


@pytest.mark.asyncio
async def test_disconnect_sets_disposed_and_blocks_reconnect() -> None:
    rt, _ws = _make_client(reconnect=True)
    await rt.connect()
    await _settle()
    await rt.disconnect()
    # connect() now raises because the client is disposed.
    with pytest.raises(AgentChatConnectionError):
        await rt.connect()


@pytest.mark.asyncio
async def test_on_disconnect_fires_on_close() -> None:
    rt, ws = _make_client()
    seen: list[dict[str, Any]] = []
    rt.on_disconnect(lambda info: seen.append(info))
    await rt.connect()
    await _settle()
    await ws.push({"type": "hello.ok"})
    await _settle()
    await ws.close(code=1000)
    await _settle()
    # Disconnect handler got the close info.
    assert len(seen) == 1
    assert seen[0]["code"] == 1000
    assert seen[0]["was_clean"] is True
    await rt.disconnect()


# ─────────────── Offline drain ───────────────


@pytest.mark.asyncio
async def test_offline_drain_after_hello_ok() -> None:
    env = {"delivery_id": 42, "message": {"conversation_id": "c1", "seq": 99, "body": "hi"}}
    mock_api = MockAsyncClient(sync_batches=[{"envelopes": [env]}, {"envelopes": []}])
    rt, ws = _make_client(client=mock_api, auto_drain_on_connect=True)
    seqs: list[int] = []
    rt.on("message.new", lambda m: seqs.append(m["payload"]["seq"]))
    try:
        await rt.connect()
        await _settle()
        await ws.push({"type": "hello.ok"})
        # Give the fire-and-forget drain task enough time to resolve.
        for _ in range(20):
            await asyncio.sleep(0.01)
            if mock_api.sync_ack_calls:
                break
        assert mock_api.sync_calls >= 1
        assert mock_api.sync_ack_calls == [42]
        assert 99 in seqs
    finally:
        await rt.disconnect()


@pytest.mark.asyncio
async def test_drain_skipped_when_auto_drain_disabled() -> None:
    mock_api = MockAsyncClient(sync_batches=[{"envelopes": []}])
    rt, ws = _make_client(client=mock_api, auto_drain_on_connect=False)
    try:
        await rt.connect()
        await _settle()
        await ws.push({"type": "hello.ok"})
        await asyncio.sleep(0.05)
        assert mock_api.sync_calls == 0
    finally:
        await rt.disconnect()


# ─────────────── Send / errors ───────────────


@pytest.mark.asyncio
async def test_send_raises_before_authentication() -> None:
    rt, _ws = _make_client()
    await rt.connect()
    await _settle()
    with pytest.raises(AgentChatConnectionError):
        await rt.send({"type": "typing.start", "payload": {"to": "@alice"}})
    await rt.disconnect()


@pytest.mark.asyncio
async def test_send_works_after_hello_ok() -> None:
    rt, ws = _make_client()
    await rt.connect()
    await _settle()
    await ws.push({"type": "hello.ok"})
    await _settle()
    await rt.send({"type": "typing.start", "payload": {"to": "@alice"}})
    # First entry is HELLO; second is the user-sent typing frame.
    assert len(ws.sent) == 2
    assert json.loads(ws.sent[1])["type"] == "typing.start"
    await rt.disconnect()


@pytest.mark.asyncio
async def test_on_unsubscribe_removes_handler() -> None:
    rt, ws = _make_client()
    count = [0]
    unsub = rt.on("message.new", lambda _m: count.__setitem__(0, count[0] + 1))
    try:
        await rt.connect()
        await _settle()
        await ws.push({"type": "hello.ok"})
        await _settle()
        await ws.push({"type": "message.new", "payload": {"conversation_id": "c1", "seq": 1}})
        await _settle()
        assert count[0] == 1
        unsub()
        await ws.push({"type": "message.new", "payload": {"conversation_id": "c1", "seq": 2}})
        await _settle()
        assert count[0] == 1
    finally:
        await rt.disconnect()


@pytest.mark.asyncio
async def test_user_handler_exception_is_logged_not_swallowed(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A raising handler must not kill the recv loop, but also must not vanish."""
    import logging

    rt, ws = _make_client()
    other_saw: list[int] = []

    def boom(_msg: dict[str, Any]) -> None:
        raise RuntimeError("handler blew up")

    rt.on("message.new", boom)
    rt.on("message.new", lambda m: other_saw.append(m["payload"]["seq"]))

    with caplog.at_level(logging.WARNING, logger="agentchat.realtime"):
        await rt.connect()
        await _settle()
        await ws.push({"type": "hello.ok"})
        await _settle()
        await ws.push({"type": "message.new", "payload": {"conversation_id": "c1", "seq": 1}})
        await _settle()
        # Second handler still fires — raise didn't break dispatch.
        assert other_saw == [1]
        # And the exception was logged, not swallowed.
        assert any(
            "handler raised" in rec.message and rec.levelno == logging.WARNING
            for rec in caplog.records
        )
    await rt.disconnect()
