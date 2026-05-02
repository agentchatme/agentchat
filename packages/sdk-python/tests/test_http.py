"""Tests for :class:`agentchat.HttpTransport` (sync).

Uses respx to mock httpx at the transport layer. The async transport
shares the same code paths; one sync pass is enough to exercise retry,
error mapping, hooks, and user-agent logic.
"""

from __future__ import annotations

import json
import re
from typing import Any

import httpx
import pytest
import respx

from agentchat import (
    AgentChatError,
    HttpTransport,
    HttpTransportOptions,
    NotFoundError,
    RateLimitedError,
    RetryPolicy,
    ServerError,
    SuspendedError,
    UnauthorizedError,
    ValidationError,
)
from agentchat import (
    ConnectionError as AgentChatConnectionError,
)
from agentchat._http import RequestHooks


def _make(**opts: Any) -> HttpTransport:
    return HttpTransport(HttpTransportOptions(base_url="https://api.test", **opts))


def test_returns_parsed_json_on_2xx() -> None:
    with respx.mock(base_url="https://api.test") as mock:
        mock.get("/ping").mock(return_value=httpx.Response(200, json={"hello": "world"}))
        http = _make()
        res = http.request("GET", "/ping")
        assert res.data == {"hello": "world"}
        assert res.status == 200
        http.close()


def test_typed_error_on_404() -> None:
    with respx.mock(base_url="https://api.test") as mock:
        mock.get("/v1/agents/@who").mock(
            return_value=httpx.Response(
                404, json={"code": "AGENT_NOT_FOUND", "message": "no such agent"}
            )
        )
        http = _make()
        with pytest.raises(NotFoundError):
            http.request("GET", "/v1/agents/@who")
        http.close()


def test_rate_limited_exposes_retry_after_ms_from_header() -> None:
    with respx.mock(base_url="https://api.test") as mock:
        mock.post("/v1/messages").mock(
            return_value=httpx.Response(
                429,
                json={"code": "RATE_LIMITED", "message": "slow down"},
                headers={"Retry-After": "7"},
            )
        )
        http = _make(retry=RetryPolicy(max_retries=0, base_delay_ms=0, max_delay_ms=0))
        with pytest.raises(RateLimitedError) as exc_info:
            http.request("POST", "/v1/messages", body={"x": 1}, retry="never")
        assert exc_info.value.retry_after_ms == 7_000
        http.close()


def test_retries_5xx_up_to_max_retries_then_throws_server_error() -> None:
    with respx.mock(base_url="https://api.test") as mock:
        route = mock.get("/ping").mock(
            return_value=httpx.Response(
                503, json={"code": "INTERNAL_ERROR", "message": "try later"}
            )
        )
        http = _make(retry=RetryPolicy(max_retries=2, base_delay_ms=1, max_delay_ms=2))
        with pytest.raises(ServerError):
            http.request("GET", "/ping")
        assert route.call_count == 3  # 1 initial + 2 retries
        http.close()


def test_succeeds_after_retry_when_server_recovers() -> None:
    with respx.mock(base_url="https://api.test") as mock:
        mock.get("/ping").mock(
            side_effect=[
                httpx.Response(500, json={"code": "INTERNAL_ERROR", "message": "boom"}),
                httpx.Response(200, json={"ok": True}),
            ]
        )
        http = _make(retry=RetryPolicy(max_retries=2, base_delay_ms=1, max_delay_ms=2))
        res = http.request("GET", "/ping")
        assert res.data == {"ok": True}
        http.close()


def test_never_retries_post_without_idempotency_opt_in() -> None:
    with respx.mock(base_url="https://api.test") as mock:
        route = mock.post("/v1/contacts").mock(
            return_value=httpx.Response(
                503, json={"code": "INTERNAL_ERROR", "message": "boom"}
            )
        )
        http = _make(retry=RetryPolicy(max_retries=3, base_delay_ms=1, max_delay_ms=2))
        with pytest.raises(ServerError):
            http.request("POST", "/v1/contacts", body={"handle": "@a"})
        assert route.call_count == 1
        http.close()


def test_retries_post_when_retry_auto() -> None:
    with respx.mock(base_url="https://api.test") as mock:
        mock.post("/v1/messages").mock(
            side_effect=[
                httpx.Response(503, json={"code": "INTERNAL_ERROR", "message": "boom"}),
                httpx.Response(200, json={"ok": True}),
            ]
        )
        http = _make(retry=RetryPolicy(max_retries=2, base_delay_ms=1, max_delay_ms=2))
        res = http.request("POST", "/v1/messages", body={"x": 1}, retry="auto")
        assert res.data == {"ok": True}
        http.close()


def test_retries_post_when_idempotency_key_supplied() -> None:
    seen: dict[str, str] = {}

    def first(request: httpx.Request) -> httpx.Response:
        seen["key"] = request.headers.get("idempotency-key", "")
        return httpx.Response(
            503, json={"code": "INTERNAL_ERROR", "message": "boom"}
        )

    with respx.mock(base_url="https://api.test") as mock:
        mock.post("/v1/any").mock(
            side_effect=[first, httpx.Response(200, json={"ok": True})]
        )
        http = _make(retry=RetryPolicy(max_retries=2, base_delay_ms=1, max_delay_ms=2))
        http.request("POST", "/v1/any", body={"x": 1}, idempotency_key="abc-123")
        assert seen["key"] == "abc-123"
        http.close()


def test_400_validation_error_is_not_retried() -> None:
    with respx.mock(base_url="https://api.test") as mock:
        route = mock.get("/ping").mock(
            return_value=httpx.Response(
                400, json={"code": "VALIDATION_ERROR", "message": "bad body"}
            )
        )
        http = _make(retry=RetryPolicy(max_retries=5, base_delay_ms=1, max_delay_ms=2))
        with pytest.raises(ValidationError):
            http.request("GET", "/ping")
        assert route.call_count == 1
        http.close()


def test_suspended_maps_to_suspended_error() -> None:
    with respx.mock(base_url="https://api.test") as mock:
        mock.get("/ping").mock(
            return_value=httpx.Response(
                403, json={"code": "SUSPENDED", "message": "account suspended"}
            )
        )
        http = _make()
        with pytest.raises(SuspendedError):
            http.request("GET", "/ping")
        http.close()


def test_unauthorized_maps_to_unauthorized_error() -> None:
    with respx.mock(base_url="https://api.test") as mock:
        mock.get("/ping").mock(
            return_value=httpx.Response(
                401, json={"code": "UNAUTHORIZED", "message": "bad key"}
            )
        )
        http = _make()
        with pytest.raises(UnauthorizedError):
            http.request("GET", "/ping")
        http.close()


def test_falls_back_to_base_agentchat_error_for_unknown_codes() -> None:
    with respx.mock(base_url="https://api.test") as mock:
        mock.get("/ping").mock(
            return_value=httpx.Response(
                418, json={"code": "SOMETHING_NEW", "message": "the future"}
            )
        )
        http = _make()
        try:
            http.request("GET", "/ping")
            pytest.fail("should throw")
        except AgentChatError as err:
            assert type(err) is AgentChatError  # not a subclass
            assert err.code == "SOMETHING_NEW"
        http.close()


def test_redacts_authorization_from_hook_info() -> None:
    captured: dict[str, Any] = {}

    def on_request(info: Any) -> None:
        captured["headers"] = info.headers

    with respx.mock(base_url="https://api.test") as mock:
        mock.get("/ping").mock(return_value=httpx.Response(200, json={"ok": True}))
        http = _make(api_key="super-secret", hooks=RequestHooks(on_request=on_request))
        http.request("GET", "/ping")
        headers = captured["headers"]
        assert headers.get("Authorization") == "Bearer ***"
        assert "super-secret" not in json.dumps(headers)
        http.close()


def test_invokes_on_retry_between_attempts() -> None:
    retries: list[Any] = []

    with respx.mock(base_url="https://api.test") as mock:
        mock.get("/ping").mock(
            side_effect=[
                httpx.Response(503, json={"code": "INTERNAL_ERROR", "message": "boom"}),
                httpx.Response(200, json={"ok": True}),
            ]
        )
        http = _make(
            retry=RetryPolicy(max_retries=2, base_delay_ms=1, max_delay_ms=2),
            hooks=RequestHooks(on_retry=lambda info: retries.append(info)),
        )
        http.request("GET", "/ping")
        assert len(retries) == 1
        assert retries[0].next_attempt == 2
        assert retries[0].status == 503
        http.close()


def test_retries_network_failure_on_idempotent_method() -> None:
    with respx.mock(base_url="https://api.test") as mock:
        mock.get("/ping").mock(
            side_effect=[
                httpx.ConnectError("socket hang up"),
                httpx.Response(200, json={"ok": True}),
            ]
        )
        http = _make(retry=RetryPolicy(max_retries=2, base_delay_ms=1, max_delay_ms=2))
        res = http.request("GET", "/ping")
        assert res.data == {"ok": True}
        http.close()


def test_surfaces_connection_error_on_exhausted_network_failures() -> None:
    with respx.mock(base_url="https://api.test") as mock:
        mock.get("/ping").mock(side_effect=httpx.ConnectError("socket hang up"))
        http = _make(retry=RetryPolicy(max_retries=0, base_delay_ms=0, max_delay_ms=0))
        with pytest.raises(AgentChatConnectionError):
            http.request("GET", "/ping")
        http.close()


def test_parses_204_no_content_as_none() -> None:
    with respx.mock(base_url="https://api.test") as mock:
        mock.delete("/v1/contacts/@a").mock(return_value=httpx.Response(204))
        http = _make()
        res = http.request("DELETE", "/v1/contacts/@a")
        assert res.data is None
        assert res.status == 204
        http.close()


def test_sends_json_body_with_content_type() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["content_type"] = request.headers.get("content-type")
        seen["body"] = json.loads(request.content.decode())
        return httpx.Response(200, json={"ok": True})

    with respx.mock(base_url="https://api.test") as mock:
        mock.post("/v1/things").mock(side_effect=handler)
        http = _make()
        http.request("POST", "/v1/things", body={"a": 1})
        assert seen["content_type"] == "application/json"
        assert seen["body"] == {"a": 1}
        http.close()


def test_attaches_default_user_agent() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["ua"] = request.headers.get("user-agent", "")
        return httpx.Response(200, json={"ok": True})

    with respx.mock(base_url="https://api.test") as mock:
        mock.get("/ping").mock(side_effect=handler)
        http = _make()
        http.request("GET", "/ping")
        assert re.match(r"^agentchat-py/\S+ \S+/\S+$", seen["ua"])
        http.close()


def test_honors_custom_user_agent_override() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["ua"] = request.headers.get("user-agent", "")
        return httpx.Response(200, json={"ok": True})

    with respx.mock(base_url="https://api.test") as mock:
        mock.get("/ping").mock(side_effect=handler)
        http = _make(user_agent="my-bot/1.0")
        http.request("GET", "/ping")
        assert seen["ua"] == "my-bot/1.0"
        http.close()


def test_omits_user_agent_when_set_to_none() -> None:
    # httpx always sends its own UA unless you pass ``User-Agent: ""``. The
    # SDK's contract is: user_agent=None → do not add the SDK-specific UA.
    # In practice httpx's own UA still appears, so we verify by absence of
    # the ``agentchat-py`` prefix rather than absence of a UA entirely.
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["ua"] = request.headers.get("user-agent", "")
        return httpx.Response(200, json={"ok": True})

    with respx.mock(base_url="https://api.test") as mock:
        mock.get("/ping").mock(side_effect=handler)
        http = _make(user_agent=None)
        http.request("GET", "/ping")
        assert "agentchat-py" not in seen["ua"]
        http.close()


def test_surfaces_request_id_on_success() -> None:
    with respx.mock(base_url="https://api.test") as mock:
        mock.get("/ping").mock(
            return_value=httpx.Response(
                200, json={"ok": True}, headers={"x-request-id": "req_abc"}
            )
        )
        http = _make()
        res = http.request("GET", "/ping")
        assert res.request_id == "req_abc"
        http.close()


def test_request_id_is_none_when_header_missing() -> None:
    with respx.mock(base_url="https://api.test") as mock:
        mock.get("/ping").mock(return_value=httpx.Response(200, json={"ok": True}))
        http = _make()
        res = http.request("GET", "/ping")
        assert res.request_id is None
        http.close()


def test_surfaces_request_id_on_error_instances() -> None:
    with respx.mock(base_url="https://api.test") as mock:
        mock.get("/ping").mock(
            return_value=httpx.Response(
                403,
                json={"code": "SUSPENDED", "message": "nope"},
                headers={"x-request-id": "req_xyz"},
            )
        )
        http = _make()
        with pytest.raises(SuspendedError) as exc_info:
            http.request("GET", "/ping")
        assert exc_info.value.request_id == "req_xyz"
        http.close()
