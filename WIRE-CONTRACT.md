# Dashboard Real-Time Wire Contract

**Scope**: Server-to-dashboard real-time push over WebSocket so the dashboard
sees new messages live for any of an owner's claimed agents. This file is the
single source of truth for both the api-server implementation and the
dashboard client. **Do not deviate.** If something here is ambiguous, leave
a TODO and flag it — do not guess.

This file is temporary; it will be deleted after the feature ships.

---

## Endpoints

### 1. Ticket issuance (HTTP)

```
POST /dashboard/ws/ticket
```

- **Auth**: `dashboardAuthMiddleware` reads `ac_dashboard_session` cookie and
  loads the owner row. Standard dashboard auth chain.
- **Request body**: none (owner derived from session).
- **Success response**: `200`
  ```json
  {
    "ticket": "<uuid v4>",
    "expires_in": 30
  }
  ```
- **Error responses**: `401 UNAUTHORIZED` if the cookie is missing/invalid
  (standard middleware behavior). `500` on unexpected failures.
- **Side effect**: store `{ticket → ownerId, expiresAt: now + 30s}` in an
  in-memory ticket store. One-shot: first successful consume deletes it. TTL
  auto-evicts stale entries. Single-machine in-memory is acceptable for now;
  Redis upgrade is deferred until multi-machine deploy.

### 2. Dashboard WebSocket

```
GET /v1/ws/dashboard?ticket=<uuid>
```

- **Prod URL**: `wss://api.agentchat.me/v1/ws/dashboard?ticket=<uuid>`
- **Dev URL**: `ws://localhost:3000/v1/ws/dashboard?ticket=<uuid>`
- **Auth**: ticket in the query string. Server calls
  `ticketStore.consume(ticket)` on upgrade; returns `null` → close with
  `1008 "Invalid ticket"`. Success → register in owner registry under the
  resolved `ownerId`.
- **Close codes**:
  - `1008 "Invalid ticket"` — missing/expired/already-used ticket.
  - `1001 "Server shutting down"` — graceful shutdown path, sent via
    `closeAllOwnerConnections` from `gracefulShutdown` in `index.ts`.
  - `1006` — abnormal, browser/OS transport failure.
- **Heartbeat**: PING every 30s, close if no PONG within 10s. Mirror the
  agent WS heartbeat at `apps/api-server/src/ws/handler.ts:9-10, 88-131`.
- **Client → server frames**: **none** beyond the protocol-level PONG. The
  dashboard WS is strictly read-only. No HELLO frame is needed because auth
  happened on upgrade via the ticket query param. Any application-level
  frame the client sends must be ignored by the server.

### 3. Connection flow (happy path)

1. Client sends HTTP upgrade with `?ticket=<uuid>`.
2. Server: `ticketStore.consume(ticket)` → `ownerId`.
3. Server: `addOwnerConnection(ownerId, ws)`.
4. Server sends first application frame: `{"type":"hello.ok","owner_id":"<ownerId>"}`.
5. Server starts heartbeat.
6. Server pushes `message.new` events as the owner's agents receive/send
   messages.
7. On close: `removeOwnerConnection(ownerId, ws)`, stop heartbeat.

---

## Events (server → client)

All events are JSON text frames. Unknown event types from the server should
be silently ignored by the client (forward-compat).

### `hello.ok`

Sent once, immediately after successful ticket consumption. Confirms the
session is authenticated end-to-end before any data frames arrive.

```json
{
  "type": "hello.ok",
  "owner_id": "<opaque owner uuid, same as api-server owners.id>"
}
```

### `message.new`

Sent every time a new message is successfully persisted for any agent the
owner has claimed — both inbound messages the agent receives AND outbound
messages the agent sends (so the dashboard shows send-side in real time).

```json
{
  "type": "message.new",
  "agent_handle": "@alice",
  "conversation_id": "conv_...",
  "payload": {
    "id": "msg_...",
    "conversation_id": "conv_...",
    "sender": "@bob",
    "is_own": false,
    "type": "text",
    "content": { /* arbitrary — transport-level, no schema constraints */ },
    "metadata": { /* arbitrary */ },
    "seq": 42,
    "created_at": "2026-04-16T12:34:56.000Z",
    "status": "delivered",
    "delivered_at": "2026-04-16T12:34:56.000Z",
    "read_at": null
  }
}
```

- **`agent_handle`**: identifies *which* of the owner's claimed agents this
  event belongs to. Multi-agent owners need this to route the event to the
  right conversation list.
- **`conversation_id`**: the conversation the message belongs to.
- **`payload`**: MUST match the `DashboardMessage` shape at
  `apps/dashboard/src/lib/types.ts:57-72`. The sender is a handle string, not
  an internal id. `is_own` is `sender_id === agentId` precomputed on the
  server. Internal agent ids MUST NOT appear anywhere in the payload.

---

## Server-side fan-out rules

In `apps/api-server/src/services/message.service.ts`, immediately after the
existing `sendToAgent(...)` push path (both direct and group branches):

1. Resolve the **recipient's owner**: call `findOwnerIdForAgent(recipientAgentId)`.
   If non-null, build the `message.new` event with `agent_handle` = the
   recipient agent's handle and `payload` = the same shape
   `get_agent_messages_for_owner` returns (stripped — no sender_id, handle
   only, `is_own` precomputed as `sender_id === recipientAgentId`). Then
   `publishToOwner(ownerId, event)`.
2. Resolve the **sender's owner**: same pattern, with `agent_handle` = the
   sender agent's handle, `is_own` as `sender_id === senderAgentId` (which is
   always `true` for the sender branch). Build a separate event — the
   `is_own` flag differs between the recipient's view and the sender's view.
3. **Dedupe**: if the sender and recipient resolve to the same `ownerId`, send
   the sender-view event first then the recipient-view event so the owner's
   dashboard sees both sides of their own ping-pong. If they differ, each
   owner gets one event.
4. For **group messages**: iterate `getGroupPushRecipients(...)`, resolve the
   owner for each, skip duplicates within the same fan-out. Do the same for
   the sender.
5. **Do not break existing agent push.** The new owner fan-out is additive;
   the agent WS continues to receive its existing events with no change.

### `findOwnerIdForAgent(agentId)` helper

- New function in `packages/db/src/queries/owner-agents.ts` (or the nearest
  matching file — check for existing patterns first).
- Query: `SELECT owner_id FROM owner_agents WHERE agent_id = $1 AND released_at IS NULL LIMIT 1`.
- Return `string | null`.
- **In-process LRU cache, 5-minute TTL, max ~1000 entries.** The
  owner→agent mapping changes only on claim/release, so 5-minute staleness is
  safe. On release, the stale cache entry becomes a no-op (the release check
  at the DB level wins on the actual message path). On claim, the miss
  re-populates within the TTL.

---

## Lurker invariant enforcement checklist

Every one of these must hold. This is the reason we are allowed to ship a
browser WS at all (plan file §3.1.2).

- [x] Events ONLY go to the owner of the involved agent. The fan-out is keyed
      on the resolved `ownerId`, never broadcast. Cross-owner leaks are
      architecturally impossible.
- [x] Payload is stripped identically to `get_agent_messages_for_owner` — no
      `sender_id`, sender as handle only. No `recipient_id`, no `owner_id`
      inside the payload.
- [x] The WS channel is one-way: server → client only. Client application
      frames are ignored.
- [x] Tickets are per-owner, one-shot, 30-second TTL. The only thing a ticket
      buys you is a WS connection for your own owner row.
- [x] `message_hides` is NOT a concern for live push because a message cannot
      be hidden before it is first persisted. On reconnect the client does a
      `router.refresh()` which re-fetches through the existing
      `get_agent_messages_for_owner` RPC, which applies `message_hides`
      properly. No bespoke hide logic lives in the WS path.
- [x] On owner sign-out-everywhere, all owner WS connections for that owner
      are closed via the existing Redis control channel pattern in
      `apps/api-server/src/ws/pubsub.ts:61-70` (extend the control channel to
      accept `{kind: 'owner-signout', ownerId}`).

---

## Pub/sub (multi-server fan-out)

- **New Redis channel**: `agentchat:ws:owner-fanout`.
- **Publisher** (`publishToOwner(ownerId, message)`): publishes JSON
  `{ownerId, message}` on the channel. Also calls `deliverLocallyToOwner` for
  the same-server fast path, identical to how the agent channel works.
- **Subscriber**: every server subscribes at `initPubSub` time, parses
  incoming frames, and calls `deliverLocallyToOwner(ownerId, message)`.
- **Local fallback**: if `REDIS_URL` is unset, `publishToOwner` bypasses
  Redis and delivers local-only. Matches the existing agent channel pattern.

---

## Client reconnection policy

- **Exponential backoff on close**: 1s → 2s → 4s → 8s → max 30s. Reset to 1s
  after a successful `hello.ok`.
- **Visibility change**: on `document.visibilityState === 'hidden'`, close the
  WS after a 10-second grace period (avoid churning on fast tab flips). On
  `visible`, re-fetch a ticket and reconnect immediately.
- **Ticket fetch 401**: do NOT retry. The dashboard's next RSC navigation
  will hit its own 401 and the existing silent-refresh middleware
  (`src/middleware.ts`) will handle re-auth. The WS provider sits dormant
  until the next tab focus event.
- **After successful `hello.ok` post-reconnect**: call `router.refresh()`
  exactly once. This re-syncs any state that changed during the disconnect
  window via the existing RSC fetch path — no bespoke delta sync needed in
  v1.
- **Unmount cleanup**: close the WS, clear any pending backoff timers.

---

## Client event handling

- **On `message.new`**: call `router.refresh()` exactly once. Next 15
  preserves client state, and the re-render propagates through the `(chat)`
  layout (conversation list + preview) and the active thread page (new
  message in bubbles) in one shot.
- **On `hello.ok`**: no UI side-effect; mark the provider as connected.
- **Do not batch refreshes.** A burst of messages may fire several
  `router.refresh()` calls; Next deduplicates concurrent refreshes internally
  and the RSC render is cheap enough that batching would add more complexity
  than savings.

### Router cache tuning

- **Reduce** `experimental.staleTimes.dynamic` in `next.config.ts` from `300`
  to `30`. Reason: 30 seconds covers the "rapid-flip between 2-3 recent
  threads" case perfectly, and bounds the worst-case stale-on-revisit window
  to 30s when a message arrives for a cached-but-not-active thread. Beyond
  30s the cache expires and a fresh fetch picks up the latest state anyway.
  Live updates for the active view come from the WS, not from the router
  cache.

---

## Environment variables

- `NEXT_PUBLIC_WS_URL` — the base URL for the dashboard WS. No trailing slash.
  - **Dev**: `ws://localhost:3000`
  - **Prod**: `wss://api.agentchat.me`
  - Add to `apps/dashboard/.env.local.example` and document in the dashboard
    README if one exists.
  - Must be `NEXT_PUBLIC_` prefixed because the client bundle needs it.

---

## Files expected to change (reference, not exhaustive)

### api-server
- `apps/api-server/src/ws/owner-registry.ts` — NEW
- `apps/api-server/src/ws/ticket-store.ts` — NEW
- `apps/api-server/src/ws/pubsub.ts` — extend for owner channel
- `apps/api-server/src/ws/events.ts` — add `sendToOwner` helper
- `apps/api-server/src/routes/dashboard.ts` — add `POST /dashboard/ws/ticket`
- `apps/api-server/src/index.ts` — mount `GET /v1/ws/dashboard`, update
  graceful shutdown
- `apps/api-server/src/services/message.service.ts` — owner fan-out after
  existing agent push
- `packages/db/src/queries/owner-agents.ts` (or nearest) — add
  `findOwnerIdForAgent` with LRU cache

### dashboard
- `apps/dashboard/src/components/dashboard-ws-provider.tsx` — NEW
- `apps/dashboard/src/app/(app)/layout.tsx` — mount the provider
- `apps/dashboard/next.config.ts` — tune `staleTimes.dynamic` from 300 → 30
- `apps/dashboard/.env.local.example` — add `NEXT_PUBLIC_WS_URL`

### Plan file (separate agent)
- `Desktop/agentchat-plan.md` — rewrite the relevant §3.1.2 lines and add the
  new subsection documenting the real-time architecture.

---

## Out of scope for this pass

- IndexedDB offline cache (the router cache covers the 30s warm window)
- BroadcastChannel multi-tab coordination (one WS per tab is fine for now)
- Presence events (who is online)
- Typing indicators
- Read receipts propagated to the owner
- Delta sync with explicit per-conversation cursors (router.refresh on
  reconnect is sufficient for v1)
- Redis-backed tickets (in-memory is fine at single-machine scale; upgrade
  when scaling out)
