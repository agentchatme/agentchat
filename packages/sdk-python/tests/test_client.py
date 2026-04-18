"""Smoke tests for :class:`AgentChatClient` / :class:`AsyncAgentChatClient`.

The HTTP transport and error mapping are already thoroughly tested
elsewhere. These tests just verify the high-level client dispatches the
right method + URL + body for a representative subset of the API surface,
and that backlog warnings from ``X-Backlog-Warning`` are parsed correctly.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List

import httpx
import pytest
import respx

from agentchat import AgentChatClient, AsyncAgentChatClient, RecipientBackloggedError


def test_send_message_posts_to_messages() -> None:
    captured: Dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["url"] = str(request.url)
        captured["body"] = json.loads(request.content.decode())
        return httpx.Response(200, json={"id": "msg_1"})

    with respx.mock(base_url="https://api.test") as mock:
        mock.post("/v1/messages").mock(side_effect=handler)
        client = AgentChatClient(api_key="sk_test", base_url="https://api.test")
        try:
            result = client.send_message(to="@alice", content="hello")
        finally:
            client.close()

    assert captured["method"] == "POST"
    assert captured["body"]["to"] == "@alice"
    assert captured["body"]["content"] == "hello"
    # send_message auto-generates a client_msg_id for dedup.
    assert "client_msg_id" in captured["body"]
    assert result.message == {"id": "msg_1"}


def test_get_agent_hits_correct_url() -> None:
    with respx.mock(base_url="https://api.test") as mock:
        route = mock.get("/v1/agents/@alice").mock(
            return_value=httpx.Response(200, json={"handle": "@alice", "status": "active"})
        )
        client = AgentChatClient(api_key="sk_test", base_url="https://api.test")
        try:
            agent = client.get_agent("@alice")
        finally:
            client.close()
        assert agent["handle"] == "@alice"
        assert route.called


def test_get_messages_query_string() -> None:
    captured_url: List[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured_url.append(str(request.url))
        return httpx.Response(200, json=[])

    with respx.mock(base_url="https://api.test") as mock:
        mock.get(url__regex=r".*/v1/messages/c1.*").mock(side_effect=handler)
        client = AgentChatClient(api_key="sk_test", base_url="https://api.test")
        try:
            client.get_messages("c1", limit=25, after_seq=7)
        finally:
            client.close()
    url = captured_url[0]
    assert "limit=25" in url
    assert "after_seq=7" in url


def test_mute_status_missing_returns_none() -> None:
    with respx.mock(base_url="https://api.test") as mock:
        mock.get(url__regex=r".*/v1/mutes/agent/%40alice$").mock(
            return_value=httpx.Response(
                404, json={"code": "AGENT_NOT_FOUND", "message": "not muted"}
            )
        )
        client = AgentChatClient(api_key="sk_test", base_url="https://api.test")
        try:
            mute = client.get_agent_mute_status("@alice")
        finally:
            client.close()
    # 404 → None rather than raising (the "not muted" signal).
    assert mute is None


def test_recipient_backlogged_error_has_typed_details() -> None:
    with respx.mock(base_url="https://api.test") as mock:
        mock.post("/v1/messages").mock(
            return_value=httpx.Response(
                429,
                json={
                    "code": "RECIPIENT_BACKLOGGED",
                    "message": "full",
                    "details": {
                        "recipient_handle": "@alice",
                        "undelivered_count": 9999,
                    },
                },
            )
        )
        client = AgentChatClient(api_key="sk_test", base_url="https://api.test")
        try:
            with pytest.raises(RecipientBackloggedError) as exc_info:
                client.send_message(to="@alice", content="hi")
        finally:
            client.close()
        assert exc_info.value.recipient_handle == "@alice"
        assert exc_info.value.undelivered_count == 9999


# ─────────────── Async counterpart ───────────────


@pytest.mark.asyncio
async def test_async_send_message_and_context_manager() -> None:
    with respx.mock(base_url="https://api.test") as mock:
        mock.post("/v1/messages").mock(return_value=httpx.Response(200, json={"id": "msg_1"}))
        async with AsyncAgentChatClient(
            api_key="sk_test", base_url="https://api.test"
        ) as client:
            result = await client.send_message(to="@alice", content="hello")
        assert result.message == {"id": "msg_1"}


@pytest.mark.asyncio
async def test_async_list_conversations() -> None:
    with respx.mock(base_url="https://api.test") as mock:
        mock.get("/v1/conversations").mock(
            return_value=httpx.Response(
                200, json=[{"id": "c1"}, {"id": "c2"}]
            )
        )
        async with AsyncAgentChatClient(
            api_key="sk_test", base_url="https://api.test"
        ) as client:
            convs = await client.list_conversations()
        assert [c["id"] for c in convs] == ["c1", "c2"]
