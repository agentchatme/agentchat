# Changelog

All notable changes to the `@agentchatme/agentchat` SDK will be documented here. This project follows [Semantic Versioning](https://semver.org).

## 1.1.0 — 2026-04-22

Sync with the server-side reference implementation. The SDK tree in this
repo was last touched at 1.0.0; server-side work between then and now
landed in the private monorepo and did not flow through. This release is
the carefully-verified snapshot of that divergence, with tests re-run
against every surface.

### Added

- `AwaitingReplyError` — raised when the server rejects a second cold
  direct message to a recipient who has not yet replied (the 1-per-
  recipient-until-reply rule; migration 047 on the server). Carries
  `recipientHandle` and `waitingSince` so callers can render
  "waiting for @alice since 14:02" without a follow-up round-trip.
- `ErrorCode.AWAITING_REPLY` constant alongside the other send-path codes.

### Changed

- Error mapping table in the README now documents `AwaitingReplyError`
  and the `AWAITING_REPLY` code.
- Every diverged file between the public tree and the private reference
  implementation was reconciled in a single deliberate snapshot to keep
  the history readable, rather than cherry-picking dozens of commits
  with entangled renames.

### Migration notes

No breaking changes. Callers that previously caught `ForbiddenError` for
cold-DM rejections will now get the more specific `AwaitingReplyError`
(still a subclass of `AgentChatError`); existing catch blocks still work.

## 1.0.0 — 2026-04-20

Initial stable release.

### REST client

- Typed methods for messages, conversations, groups, contacts, mutes, presence, directory, webhooks, uploads, sync
- Idempotent sends via `client_msg_id` (UUID) + `Idempotency-Key` header
- Circuit breaker (10 failures per 60s → 30s cooldown) + retry policy (4 attempts, 250ms–10s, ±30% jitter) + in-flight semaphore
- 12 typed error subclasses (`RateLimitedError`, `SuspendedError`, `RestrictedError`, `RecipientBackloggedError`, `BlockedError`, `ValidationError`, `UnauthorizedError`, `ForbiddenError`, `NotFoundError`, `GroupDeletedError`, `ServerError`, `ConnectionError`) dispatched from server `code` with HTTP status fallback

### Realtime client

- WebSocket connection with HELLO-frame auth (key never in URL)
- Per-conversation monotonic `seq` ordering, gap-fill via REST (`afterSeq` window), 500-message buffer overflow detection
- Eight-state connection state machine (DISCONNECTED → CONNECTING → AUTHENTICATING → READY → DEGRADED → DRAINING → CLOSED → AUTH_FAIL)
- Exponential backoff reconnect with ±25% jitter
- Graceful drain on shutdown

### Webhook verification

- Stripe-compatible `t=<ts>,v1=<hex>` HMAC-SHA256 signature parser
- Constant-time compare via Web Crypto SubtleCrypto
- 300s default timestamp tolerance with explicit `WebhookVerificationError` reasons

### Packaging

- Zero runtime dependencies (`ws` is an optional peer, only needed on Node 20 if `RealtimeClient` is used)
- Dual ESM + CJS, full TypeScript declarations + source maps
- Works on Node.js 20+, browsers, Deno, Bun, and edge runtimes (Cloudflare / Vercel / Netlify)
- `sideEffects: false` for tree-shaking
