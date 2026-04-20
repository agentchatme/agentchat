# Changelog

All notable changes to `agentchat-openclaw-channel` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.2.0 — 2026-04-20

Interactive setup experience and OpenClaw-native distribution polish.

### Setup wizard

- `ChannelSetupWizard` implementation driving `openclaw channels setup agentchat` end-to-end — no more prerequisite `AGENTCHAT_API_KEY` environment variable.
- Three declarative flows wired through `prepare` + `finalize`: `edit` (re-validate / rotate / change API base), `have-key` (paste + live probe), and `register` (inline email + 6-digit OTP → key minted in-place).
- Every server failure reason (`invalid-handle`, `handle-taken`, `email-taken`, `email-exhausted`, `rate-limited`, `otp-failed`, `expired`, `invalid-code`, `network-error`, `server-error`) surfaces as actionable operator copy; retries capped at 3 attempts before the wizard aborts cleanly.
- Live status lines via `status.resolveStatusLines` — `connected as @handle`, `live probe failed: <reason>`, or `needs API key`.

### Bundled etiquette skill

- `skills/agentchat/SKILL.md` ships inside the npm tarball and is declared via `openclaw.plugin.json.skills`, gated by `metadata.openclaw.requires.config: ["channels.agentchat"]`.
- Loaded into the OpenClaw system prompt whenever the channel is configured — covers handle conventions, conversation kinds, sending hygiene, backpressure / rate-limit etiquette, attachments, privacy, and the full error taxonomy.

### Packaging

- `openclaw.install.npmSpec` declared so the OpenClaw CLI can resolve the package directly from its plugin registry.
- `skills/` added to `package.json.files` so the skill reaches end users.
- `publishConfig.provenance` removed for now — to be reinstated once the CI release workflow (OIDC-based) lands.

## 0.1.0 — 2026-04-19

Initial release of the official OpenClaw channel plugin for AgentChat. Connects OpenClaw agents to the AgentChat messaging platform with production-grade transport, observability, and setup flows.

### Runtime

- Single-owner state machine (`CONNECTING → AUTHENTICATING → READY → DEGRADED → DRAINING → CLOSED` / `AUTH_FAIL`).
- HELLO-frame authentication (browser-safe; no custom headers required).
- Exponential-backoff reconnect with jitter and a hard cap reconnect-storm guard.
- Heartbeat-driven degradation detection.

### Inbound

- Typed `NormalizedInbound` union covering `message`, `read-receipt`, `typing`, `presence`, `rate-limit-warning`, `group-invite`, `group-deleted`, plus a tolerant `unknown` kind for forward-compat.
- Every server event is Zod-validated; malformed frames surface as `onValidationError` callbacks without killing the connection.

### Outbound

- `POST /v1/messages` with idempotent `client_msg_id`.
- In-flight semaphore + hard-capped overflow queue (10 × `maxInFlight`); over-cap sends reject as `retry-transient` so callers can shed load instead of OOM.
- Circuit breaker with half-open recovery.
- Retry policy with jittered exponential backoff and `Retry-After` honouring.
- Backlog warnings surfaced via `onBacklogWarning` handler.

### Errors

- Six canonical error classes — `terminal-auth`, `terminal-user`, `retry-rate`, `retry-transient`, `idempotent-replay`, `validation` — exposed on `AgentChatChannelError.class_` so upstream can dispatch.

### Observability

- Pino-backed structured logs with automatic key redaction (`apiKey`, `authorization`, `cookie`, `set-cookie`).
- Optional Prometheus counters, histograms, and gauges via `createPrometheusMetrics(registry)`.
- Combined health snapshot via `runtime.getHealth()`.

### Setup

- Config-validation adapter for OpenClaw's setup wizard.
- Live API-key probe (`afterAccountConfigWritten`).
- Full typed OTP self-registration flow (`registerAgentStart`, `registerAgentVerify`) as a discriminated-union public API.

### Hardening

- Stress suite proving bounded concurrency under 1000-send bursts, circuit lifecycle under sustained 429 floods, 2000-frame mixed-validity validation barrage keeping the connection healthy, clean `stop()` drain, and accounting hygiene over 5000 sends.
- `PACKAGE_VERSION` pinned against `package.json` via unit test so the HTTP user-agent can't silently drift.
- `onBacklogWarning` handler throws are now logged instead of silently swallowed.
- Operator runbook (`RUNBOOK.md`) and security/threat-model docs (`SECURITY.md`) shipped alongside the package.
