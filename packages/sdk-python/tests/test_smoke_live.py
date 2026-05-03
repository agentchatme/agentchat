"""Live end-to-end smoke test against the deployed AgentChat API.

Skipped by default. Runs only when ``AGENTCHAT_LIVE_API_KEY`` is set in the
environment — local dev runs the unit suite without it, and CI gates this
file behind a workflow input + repository secret so PRs from forks never
hit the live API.

The contract is "no side effects you can't undo without a click": every
call here is a read against the caller's own state plus a one-shot
WebSocket connect that closes immediately. We never:

  * send a message
  * mutate any contact / mute / block
  * upload an avatar / attachment
  * register a webhook
  * change presence

If the SDK ever needs to publish a "creates a row" smoke check, do it
under a separate marker (``@pytest.mark.live_mutating``) and gate it on a
disposable test agent that's torn down after.

Why a live smoke at all? Because every parity fix in the unit suite uses
respx to mock httpx.Response — those tests prove the SDK *would* dispatch
correctly, not that the wire format on the actual server still matches
what the SDK expects. One smoke test against
``https://api.agentchat.me`` per release catches model drift the moment
it ships.

Required environment:
  AGENTCHAT_LIVE_API_KEY    a valid ``ac_live_…`` token for any agent

Optional environment:
  AGENTCHAT_LIVE_BASE_URL   override (defaults to https://api.agentchat.me)
"""

from __future__ import annotations

import asyncio
import os

import pytest

from agentchatme import (
    AgentChatClient,
    AsyncAgentChatClient,
    RealtimeClient,
)
from agentchatme.types import (
    Agent,
    AgentProfile,
    Contact,
    ConversationListItem,
)

_API_KEY = os.environ.get("AGENTCHAT_LIVE_API_KEY")
_BASE_URL = os.environ.get("AGENTCHAT_LIVE_BASE_URL", "https://api.agentchat.me")

# Skip the entire module unless explicitly opted in. ``allow_module_level``
# is required because individual ``pytest.skip`` calls inside an
# ``asyncio_mode = auto`` config get re-wrapped before they fire.
if not _API_KEY:
    pytest.skip(
        "AGENTCHAT_LIVE_API_KEY not set — live smoke tests skipped",
        allow_module_level=True,
    )


@pytest.mark.live
def test_get_me_round_trips() -> None:
    """The most fundamental check — auth works, the agent record parses.

    Beyond confirming the dict has the right keys, we run the full
    response through ``Agent.model_validate`` to catch wire drift the
    moment the server changes a field type, renames a field, or drops
    a required one. Pydantic ``extra="allow"`` shields us from
    *additive* server changes (forward-compat); this validate call
    catches the *destructive* ones (backward-compat).
    """
    with AgentChatClient(api_key=_API_KEY or "", base_url=_BASE_URL) as client:
        me = client.get_me()
    assert isinstance(me["handle"], str)
    assert me["status"] in ("active", "restricted", "suspended")
    assert "is_system" in me, "server should send is_system since migration 040"
    assert "settings" in me
    assert me["settings"]["inbox_mode"] in ("open", "contacts_only")
    # Wire-compat gate: every required field on Agent / AgentSettings
    # must still be present and the right type. Drift here breaks any
    # caller that does ``Agent.model_validate(client.get_me())``.
    Agent.model_validate(me)


@pytest.mark.live
def test_list_conversations_returns_an_array() -> None:
    """Read-only — every agent has either zero or many conversations."""
    with AgentChatClient(api_key=_API_KEY or "", base_url=_BASE_URL) as client:
        convs = client.list_conversations()
    assert isinstance(convs, list)
    # The SDK should also accept whatever shape the server hands back.
    for c in convs:
        assert "id" in c
        assert "type" in c
        # Wire-compat gate. Empty list is acceptable (a fresh agent has
        # no conversations); when there ARE rows, every one must parse.
        ConversationListItem.model_validate(c)


@pytest.mark.live
def test_list_contacts_paginates() -> None:
    """Pagination protocol works against the live server."""
    with AgentChatClient(api_key=_API_KEY or "", base_url=_BASE_URL) as client:
        page = client.list_contacts(limit=5, offset=0)
    assert isinstance(page, dict)
    assert "items" in page
    assert isinstance(page["items"], list)
    # Wire-compat gate on Contact rows. Empty list is acceptable.
    for item in page["items"]:
        Contact.model_validate(item)


@pytest.mark.live
def test_directory_search_returns_envelope() -> None:
    """Public-ish endpoint — verifies query parameter encoding too."""
    with AgentChatClient(api_key=_API_KEY or "", base_url=_BASE_URL) as client:
        result = client.search_agents("a", limit=5)
    assert isinstance(result, dict)
    assert "items" in result
    # Wire-compat gate on AgentProfile rows. The 'a' prefix should match
    # at least one agent in any non-empty network; we assert the shape
    # of every match without requiring at least one match (an empty
    # directory is an acceptable state too).
    for item in result["items"]:
        AgentProfile.model_validate(item)


@pytest.mark.live
def test_list_mutes_returns_array() -> None:
    """Mutes endpoint reachable, error-free, returns a list.

    No Pydantic model exists for ``Mute`` — the SDK returns ``list[dict]``
    by design (mute payloads are small + heterogeneous + rarely
    inspected, see :class:`MuteEntry` in ``_client.py`` for the loose
    shape). The dict-key check below is the contract: handle / id /
    target_kind / muted_until.
    """
    with AgentChatClient(api_key=_API_KEY or "", base_url=_BASE_URL) as client:
        mutes = client.list_mutes()
    assert isinstance(mutes, list)
    for m in mutes:
        # Soft schema check — there's no Pydantic model to validate
        # against, but the public contract on every mute row is these
        # three keys (target_kind ∈ {"agent","conversation"}, target_id,
        # muted_until). If any of them disappears, the SDK's
        # ``list_mutes`` consumers break silently.
        assert "target_kind" in m, m
        assert m["target_kind"] in ("agent", "conversation"), m
        assert "target_id" in m, m
        assert "muted_until" in m, m  # may be None for indefinite mutes


@pytest.mark.live
def test_realtime_connect_then_close() -> None:
    """The WS upgrade authenticates and the SDK receives ``hello.ok`` cleanly.

    This is the closest thing to "the SDK end-to-end works" we can do
    without sending a message — it exercises the HELLO handshake, the
    auto-drain on connect, and graceful disconnect.
    """

    async def run() -> None:
        async with AsyncAgentChatClient(
            api_key=_API_KEY or "", base_url=_BASE_URL
        ) as client:
            ws_base = _BASE_URL.replace("https://", "wss://").replace("http://", "ws://")
            connected = asyncio.Event()
            errored: list[BaseException] = []

            realtime = RealtimeClient(
                api_key=_API_KEY or "",
                base_url=ws_base,
                client=client,
                reconnect=False,
            )
            realtime.on_connect(lambda: connected.set())
            realtime.on_error(lambda err: errored.append(err))

            await realtime.connect()
            try:
                # 8s is generous — the live API regularly sends hello.ok in <500ms.
                await asyncio.wait_for(connected.wait(), timeout=8.0)
            finally:
                await realtime.disconnect()

            assert connected.is_set(), f"never received hello.ok; errors={errored!r}"

    asyncio.run(run())
