"""HTTP transport with retry policy, hooks, and request-id propagation.

Two transport classes — :class:`HttpTransport` (sync) and
:class:`AsyncHttpTransport` (async). Both share policy/helpers defined at
module level and only differ in how they drive the underlying httpx
client. The public contract matches the TypeScript SDK 1:1 where possible
so docs and examples translate directly.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import random
import time
from dataclasses import dataclass, field, replace
from typing import (
    Any,
    Awaitable,
    Callable,
    Dict,
    Literal,
    Mapping,
    Optional,
    TypeVar,
    Union,
)

import httpx

from ._http_retry_after import parse_retry_after
from ._runtime import default_user_agent
from .errors import (
    AgentChatError,
    ConnectionError,
    create_agentchat_error,
)

T = TypeVar("T")

HttpMethod = Literal["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]

REQUEST_ID_HEADER = "x-request-id"

_IDEMPOTENT_METHODS = frozenset({"GET", "HEAD", "PUT", "DELETE"})

_RETRIABLE_STATUSES = frozenset({408, 425, 429, 500, 502, 503, 504})


@dataclass(frozen=True)
class RetryPolicy:
    """Controls automatic retries on idempotent + opted-in requests.

    ``base_delay_ms`` is the first sleep duration; each subsequent attempt
    doubles it with ±25% jitter, capped at ``max_delay_ms``.
    ``max_retries`` counts retries *after* the first attempt — so 3 means
    up to 4 total HTTP requests.

    A ``Retry-After`` response header always overrides the backoff formula.
    """

    max_retries: int = 3
    base_delay_ms: int = 250
    max_delay_ms: int = 8_000


DEFAULT_RETRY_POLICY = RetryPolicy()

RetryOption = Union[Literal["auto", "never"], RetryPolicy]


@dataclass
class RequestInfo:
    method: HttpMethod
    url: str
    attempt: int
    headers: Dict[str, str]
    """The request headers. ``Authorization`` is always redacted to ``Bearer ***`` — hooks must never see the raw key."""


@dataclass
class ResponseInfo(RequestInfo):
    status: int = 0
    duration_ms: float = 0.0


@dataclass
class ErrorInfo(RequestInfo):
    duration_ms: float = 0.0
    error: Optional[BaseException] = None
    status: Optional[int] = None


@dataclass
class RetryInfo(RequestInfo):
    delay_ms: int = 0
    next_attempt: int = 0
    status: Optional[int] = None
    error: Optional[BaseException] = None


@dataclass
class RequestHooks:
    """Observability hooks fired around each HTTP attempt.

    Every hook is optional and may be either sync or async — the transport
    inspects each one at invocation time. Exceptions inside hooks are
    swallowed: the transport never lets observability break a request.
    """

    on_request: Optional[Callable[[RequestInfo], Union[None, Awaitable[None]]]] = None
    on_response: Optional[Callable[[ResponseInfo], Union[None, Awaitable[None]]]] = None
    on_error: Optional[Callable[[ErrorInfo], Union[None, Awaitable[None]]]] = None
    on_retry: Optional[Callable[[RetryInfo], Union[None, Awaitable[None]]]] = None


@dataclass
class HttpResponse:
    """Envelope returned by every successful HTTP request.

    ``request_id`` is the server's ``x-request-id`` header (or ``None``).
    Surface it to users in log lines — support tickets are resolved in
    seconds when the request id is present.
    """

    data: Any
    headers: httpx.Headers
    status: int
    request_id: Optional[str]


# Sentinel for an omitted user_agent argument — lets callers distinguish
# "not passed" (→ default) from "explicit None" (→ omit header).
class _Unset:
    pass


_UNSET: Any = _Unset()


@dataclass
class HttpTransportOptions:
    """Construction options shared by sync and async transports."""

    base_url: str
    api_key: Optional[str] = None
    timeout_ms: int = 30_000
    retry: RetryPolicy = field(default_factory=lambda: DEFAULT_RETRY_POLICY)
    hooks: RequestHooks = field(default_factory=RequestHooks)
    default_headers: Dict[str, str] = field(default_factory=dict)
    user_agent: Any = _UNSET
    """Override the default ``User-Agent``. Pass ``None`` to omit entirely.
    Leave at default to use ``agentchat-py/<version> <runtime>/<version>``."""


def _normalize_user_agent(opt: Any) -> Optional[str]:
    if isinstance(opt, _Unset):
        return default_user_agent()
    return opt  # str or None


def _resolve_retry_policy(
    opt: Union[RetryOption, None], fallback: RetryPolicy
) -> RetryPolicy:
    if isinstance(opt, RetryPolicy):
        return opt
    return fallback


def _is_retry_eligible(
    method: HttpMethod,
    idempotency_key: Optional[str],
    retry: Union[RetryOption, None],
) -> bool:
    if retry == "never":
        return False
    if retry == "auto" or isinstance(retry, RetryPolicy):
        return True
    if idempotency_key:
        return True
    return method in _IDEMPOTENT_METHODS


def _compute_delay_ms(
    policy: RetryPolicy, attempt: int, retry_after_ms: Optional[int]
) -> int:
    if retry_after_ms is not None:
        return min(retry_after_ms, policy.max_delay_ms)
    exp = policy.base_delay_ms * (2 ** (attempt - 1))
    capped = min(exp, policy.max_delay_ms)
    jitter = 1 - 0.25 + random.random() * 0.5  # ±25%
    return max(0, int(capped * jitter))


def _build_headers_and_body(
    *,
    default_headers: Mapping[str, str],
    user_agent: Optional[str],
    api_key: Optional[str],
    per_request_headers: Optional[Mapping[str, str]],
    idempotency_key: Optional[str],
    body: Any,
    raw_body: bool,
) -> tuple[Dict[str, str], Dict[str, str], Any]:
    headers: Dict[str, str] = {**default_headers}
    if per_request_headers:
        headers.update(per_request_headers)

    if user_agent and not _has_header(headers, "user-agent"):
        headers["User-Agent"] = user_agent
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key

    wire_body: Any
    if body is None:
        wire_body = None
    elif raw_body:
        wire_body = body
    else:
        wire_body = json.dumps(body).encode("utf-8")
        if not _has_header(headers, "content-type"):
            headers["Content-Type"] = "application/json"

    redacted = dict(headers)
    if redacted.get("Authorization"):
        redacted["Authorization"] = "Bearer ***"

    return headers, redacted, wire_body


def _has_header(headers: Mapping[str, str], name: str) -> bool:
    lower = name.lower()
    return any(k.lower() == lower for k in headers)


def _parse_error_body(response: httpx.Response) -> Dict[str, Any]:
    """Produce the ``AgentChatErrorResponse``-shaped dict for a failing response."""
    try:
        text = response.text
    except Exception:
        text = ""
    if not text:
        return {
            "code": _status_to_code(response.status_code),
            "message": response.reason_phrase or "Request failed",
        }
    try:
        parsed = json.loads(text)
    except Exception:
        return {
            "code": _status_to_code(response.status_code),
            "message": response.reason_phrase or "Request failed",
        }
    if (
        isinstance(parsed, dict)
        and isinstance(parsed.get("code"), str)
        and isinstance(parsed.get("message"), str)
    ):
        return parsed
    return {
        "code": _status_to_code(response.status_code),
        "message": response.reason_phrase or "Request failed",
        "details": {"body": parsed},
    }


def _status_to_code(status: int) -> str:
    """Fallback code used when an error response has no JSON body.

    Values align with the server's ``ErrorCode`` enum so downstream
    switches on ``err.code`` behave consistently whether the body
    parsed or not.
    """
    if status == 400:
        return "VALIDATION_ERROR"
    if status == 401:
        return "UNAUTHORIZED"
    if status == 403:
        return "FORBIDDEN"
    if status == 404:
        return "AGENT_NOT_FOUND"
    if status == 410:
        return "GROUP_DELETED"
    if status == 429:
        return "RATE_LIMITED"
    return "INTERNAL_ERROR"


def _parse_success_body(response: httpx.Response) -> Any:
    if response.status_code == 204:
        return None
    text = response.text
    if not text:
        return None
    try:
        return json.loads(text)
    except Exception as exc:  # noqa: BLE001
        raise ConnectionError(
            f"AgentChat SDK: expected JSON response but got: {text[:200]}"
        ) from exc


def _to_connection_error(err: BaseException) -> BaseException:
    if isinstance(err, (AgentChatError, ConnectionError)):
        return err
    if isinstance(err, httpx.TimeoutException):
        return ConnectionError(f"AgentChat SDK: request timed out ({err!s})")
    if isinstance(err, httpx.HTTPError):
        return ConnectionError(str(err) or type(err).__name__)
    return ConnectionError(str(err))


def _httpx_timeout(timeout_ms: int) -> Optional[httpx.Timeout]:
    if timeout_ms <= 0:
        return None
    seconds = timeout_ms / 1000.0
    return httpx.Timeout(seconds)


def _safe_invoke_sync(hook: Optional[Callable[[Any], Any]], info: Any) -> None:
    if hook is None:
        return
    try:
        result = hook(info)
        # Sync transport intentionally does NOT await coroutines — users
        # wiring async hooks into the sync transport deserve the loud hint.
        if inspect.iscoroutine(result):
            result.close()
    except Exception:  # noqa: BLE001
        # Hooks must never break requests.
        pass


async def _safe_invoke_async(hook: Optional[Callable[[Any], Any]], info: Any) -> None:
    if hook is None:
        return
    try:
        result = hook(info)
        if inspect.iscoroutine(result):
            await result
    except Exception:  # noqa: BLE001
        pass


# ─── Sync transport ───────────────────────────────────────────────────────────


class HttpTransport:
    """Sync HTTP transport. Uses :class:`httpx.Client` under the hood."""

    def __init__(self, options: HttpTransportOptions, *, client: Optional[httpx.Client] = None) -> None:
        self._options = options
        self._base_url = options.base_url.rstrip("/")
        self._user_agent = _normalize_user_agent(options.user_agent)
        self._owned = client is None
        self._client: httpx.Client = client or httpx.Client(timeout=_httpx_timeout(options.timeout_ms))

    def close(self) -> None:
        if self._owned:
            self._client.close()

    def __enter__(self) -> "HttpTransport":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def request(
        self,
        method: HttpMethod,
        path: str,
        *,
        body: Any = None,
        headers: Optional[Mapping[str, str]] = None,
        retry: Union[RetryOption, None] = None,
        idempotency_key: Optional[str] = None,
        timeout_ms: Optional[int] = None,
        raw_body: bool = False,
    ) -> HttpResponse:
        url = f"{self._base_url}{path}"
        opts = self._options
        policy = _resolve_retry_policy(retry, opts.retry)
        can_retry = _is_retry_eligible(method, idempotency_key, retry)
        max_attempts = policy.max_retries + 1 if can_retry else 1
        timeout = _httpx_timeout(timeout_ms if timeout_ms is not None else opts.timeout_ms)

        last_error: Optional[BaseException] = None
        for attempt in range(1, max_attempts + 1):
            started = time.perf_counter()
            built_headers, redacted, wire_body = _build_headers_and_body(
                default_headers=opts.default_headers,
                user_agent=self._user_agent,
                api_key=opts.api_key,
                per_request_headers=headers,
                idempotency_key=idempotency_key,
                body=body,
                raw_body=raw_body,
            )
            request_info = RequestInfo(method=method, url=url, attempt=attempt, headers=redacted)
            _safe_invoke_sync(opts.hooks.on_request, request_info)

            try:
                response = self._client.request(
                    method,
                    url,
                    headers=built_headers,
                    content=wire_body,
                    timeout=timeout,
                )
            except Exception as exc:  # noqa: BLE001
                error = _to_connection_error(exc)
                duration_ms = (time.perf_counter() - started) * 1000
                _safe_invoke_sync(
                    opts.hooks.on_error,
                    ErrorInfo(
                        method=method,
                        url=url,
                        attempt=attempt,
                        headers=redacted,
                        duration_ms=duration_ms,
                        error=error,
                    ),
                )
                if attempt < max_attempts and can_retry:
                    delay_ms = _compute_delay_ms(policy, attempt, None)
                    _safe_invoke_sync(
                        opts.hooks.on_retry,
                        RetryInfo(
                            method=method,
                            url=url,
                            attempt=attempt,
                            headers=redacted,
                            delay_ms=delay_ms,
                            next_attempt=attempt + 1,
                            error=error,
                        ),
                    )
                    time.sleep(delay_ms / 1000.0)
                    last_error = error
                    continue
                raise error from exc

            duration_ms = (time.perf_counter() - started) * 1000

            if response.is_success:
                _safe_invoke_sync(
                    opts.hooks.on_response,
                    ResponseInfo(
                        method=method,
                        url=url,
                        attempt=attempt,
                        headers=redacted,
                        status=response.status_code,
                        duration_ms=duration_ms,
                    ),
                )
                data = _parse_success_body(response)
                return HttpResponse(
                    data=data,
                    headers=response.headers,
                    status=response.status_code,
                    request_id=response.headers.get(REQUEST_ID_HEADER),
                )

            err_body = _parse_error_body(response)
            error = create_agentchat_error(err_body, response.status_code, response.headers)
            _safe_invoke_sync(
                opts.hooks.on_error,
                ErrorInfo(
                    method=method,
                    url=url,
                    attempt=attempt,
                    headers=redacted,
                    status=response.status_code,
                    duration_ms=duration_ms,
                    error=error,
                ),
            )

            retriable = (
                can_retry
                and attempt < max_attempts
                and response.status_code in _RETRIABLE_STATUSES
            )
            if retriable:
                retry_after = parse_retry_after(response.headers.get("retry-after"))
                delay_ms = _compute_delay_ms(policy, attempt, retry_after)
                _safe_invoke_sync(
                    opts.hooks.on_retry,
                    RetryInfo(
                        method=method,
                        url=url,
                        attempt=attempt,
                        headers=redacted,
                        status=response.status_code,
                        delay_ms=delay_ms,
                        next_attempt=attempt + 1,
                        error=error,
                    ),
                )
                time.sleep(delay_ms / 1000.0)
                last_error = error
                continue

            raise error

        # Defensive: loop should always return or raise.
        raise last_error or ConnectionError("AgentChat SDK: request loop exited without a result")


# ─── Async transport ──────────────────────────────────────────────────────────


class AsyncHttpTransport:
    """Async HTTP transport. Uses :class:`httpx.AsyncClient` under the hood."""

    def __init__(
        self,
        options: HttpTransportOptions,
        *,
        client: Optional[httpx.AsyncClient] = None,
    ) -> None:
        self._options = options
        self._base_url = options.base_url.rstrip("/")
        self._user_agent = _normalize_user_agent(options.user_agent)
        self._owned = client is None
        self._client: httpx.AsyncClient = client or httpx.AsyncClient(
            timeout=_httpx_timeout(options.timeout_ms)
        )

    async def aclose(self) -> None:
        if self._owned:
            await self._client.aclose()

    async def __aenter__(self) -> "AsyncHttpTransport":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.aclose()

    async def request(
        self,
        method: HttpMethod,
        path: str,
        *,
        body: Any = None,
        headers: Optional[Mapping[str, str]] = None,
        retry: Union[RetryOption, None] = None,
        idempotency_key: Optional[str] = None,
        timeout_ms: Optional[int] = None,
        raw_body: bool = False,
    ) -> HttpResponse:
        url = f"{self._base_url}{path}"
        opts = self._options
        policy = _resolve_retry_policy(retry, opts.retry)
        can_retry = _is_retry_eligible(method, idempotency_key, retry)
        max_attempts = policy.max_retries + 1 if can_retry else 1
        timeout = _httpx_timeout(timeout_ms if timeout_ms is not None else opts.timeout_ms)

        last_error: Optional[BaseException] = None
        for attempt in range(1, max_attempts + 1):
            started = time.perf_counter()
            built_headers, redacted, wire_body = _build_headers_and_body(
                default_headers=opts.default_headers,
                user_agent=self._user_agent,
                api_key=opts.api_key,
                per_request_headers=headers,
                idempotency_key=idempotency_key,
                body=body,
                raw_body=raw_body,
            )
            request_info = RequestInfo(method=method, url=url, attempt=attempt, headers=redacted)
            await _safe_invoke_async(opts.hooks.on_request, request_info)

            try:
                response = await self._client.request(
                    method,
                    url,
                    headers=built_headers,
                    content=wire_body,
                    timeout=timeout,
                )
            except Exception as exc:  # noqa: BLE001
                error = _to_connection_error(exc)
                duration_ms = (time.perf_counter() - started) * 1000
                await _safe_invoke_async(
                    opts.hooks.on_error,
                    ErrorInfo(
                        method=method,
                        url=url,
                        attempt=attempt,
                        headers=redacted,
                        duration_ms=duration_ms,
                        error=error,
                    ),
                )
                if attempt < max_attempts and can_retry:
                    delay_ms = _compute_delay_ms(policy, attempt, None)
                    await _safe_invoke_async(
                        opts.hooks.on_retry,
                        RetryInfo(
                            method=method,
                            url=url,
                            attempt=attempt,
                            headers=redacted,
                            delay_ms=delay_ms,
                            next_attempt=attempt + 1,
                            error=error,
                        ),
                    )
                    await asyncio.sleep(delay_ms / 1000.0)
                    last_error = error
                    continue
                raise error from exc

            duration_ms = (time.perf_counter() - started) * 1000

            if response.is_success:
                await _safe_invoke_async(
                    opts.hooks.on_response,
                    ResponseInfo(
                        method=method,
                        url=url,
                        attempt=attempt,
                        headers=redacted,
                        status=response.status_code,
                        duration_ms=duration_ms,
                    ),
                )
                data = _parse_success_body(response)
                return HttpResponse(
                    data=data,
                    headers=response.headers,
                    status=response.status_code,
                    request_id=response.headers.get(REQUEST_ID_HEADER),
                )

            err_body = _parse_error_body(response)
            error = create_agentchat_error(err_body, response.status_code, response.headers)
            await _safe_invoke_async(
                opts.hooks.on_error,
                ErrorInfo(
                    method=method,
                    url=url,
                    attempt=attempt,
                    headers=redacted,
                    status=response.status_code,
                    duration_ms=duration_ms,
                    error=error,
                ),
            )

            retriable = (
                can_retry
                and attempt < max_attempts
                and response.status_code in _RETRIABLE_STATUSES
            )
            if retriable:
                retry_after = parse_retry_after(response.headers.get("retry-after"))
                delay_ms = _compute_delay_ms(policy, attempt, retry_after)
                await _safe_invoke_async(
                    opts.hooks.on_retry,
                    RetryInfo(
                        method=method,
                        url=url,
                        attempt=attempt,
                        headers=redacted,
                        status=response.status_code,
                        delay_ms=delay_ms,
                        next_attempt=attempt + 1,
                        error=error,
                    ),
                )
                await asyncio.sleep(delay_ms / 1000.0)
                last_error = error
                continue

            raise error

        raise last_error or ConnectionError("AgentChat SDK: request loop exited without a result")


def override_retry(policy: RetryPolicy, **overrides: Any) -> RetryPolicy:
    """Convenience for ``replace`` on a :class:`RetryPolicy`."""
    return replace(policy, **overrides)
