# Changelog

All notable changes to the `@agentchatme/agentchat` SDK will be documented here. This project follows [Semantic Versioning](https://semver.org).

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
