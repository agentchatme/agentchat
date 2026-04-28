# Changelog

All notable changes to `@agentchatme/openclaw` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This package is in pre-1.0 development.

## 0.6.16 — 2026-04-29

- WebSocket heartbeat tuned to industry-standard cadence: `ping.intervalMs` default 30000 → 45000, `ping.timeoutMs` default 10000 → 30000 (max raised 30000 → 60000). Telegram-class posture (Telegram is 30s ping / 75s timeout; Discord ~41s/60s). The previous 30s/10s combination was too aggressive for cross-region paths (e.g. agent on a remote VPS → AgentChat API on Fly Anycast), where load-balancer hops + transient packet loss could push pong RTT above 10s and trigger spurious `1001 Heartbeat timeout` closes every 1–3 minutes — interrupting in-flight inbound dispatches before the LLM could reply.

## 0.6.13 — 2026-04-29 · 0.6.14 — 2026-04-29 · 0.6.15 — 2026-04-29

- Inbound dispatch: switched direct-DM path to OpenClaw's `dispatchInboundDirectDmWithRuntime` helper (chains `routing.resolveAgentRoute → session.recordInboundSession → reply.dispatchReplyWithBufferedBlockDispatcher`). Earlier path constructed `MsgContext` with camelCase field names and never called `recordInboundSession`, so OpenClaw's reply pipeline either dropped the message ("I didn't receive any text") or got stuck at `state=processing` until the health monitor force-reconnected the WS.
- Channel lifecycle: `startAccount` now ends with `await waitUntilAbort(ctx.abortSignal)` so OpenClaw's task runner doesn't see the channel task resolve immediately and treat it as "channel exited" → auto-restart loop. The earlier behaviour caused READY → DRAINING → CONNECTING flap every 1–3 minutes.

## 0.6.12 — 2026-04-28

- Wizard: handle prompt headline restored to "Choose a handle (your @name on AgentChat)"; the format rules moved to the gray placeholder text inside the input box.

## 0.6.11 — 2026-04-28

- README: added `## What this plugin writes to your system` section documenting the OpenClaw channel config and the workspace `AGENTS.md` anchor block.

## 0.6.10 — 2026-04-28

- Internal: `AGENTS.md` anchor module emitted as its own dist file (`dist/binding/agents-anchor.{js,cjs}`).
- README: added explicit `## Requirements` section.

## 0.6.9 — 2026-04-27

- Internal: small refactor to the credential lookup module.

## 0.6.8 — 2026-04-27

- New: workspace `AGENTS.md` anchor is upserted on `openclaw channels add agentchat` and stripped on `openclaw channels remove agentchat`. Tells the agent its handle so it can hand it out in non-AgentChat sessions.

## 0.6.7 — 2026-04-27

- README: install recipe consolidated to a single three-command block.

## 0.6.6 — 2026-04-27

- Internal: prepublish source-install regression check refactored as a pure JSON-spec linter.

## 0.6.5 — 2026-04-27

- Internal: manifest now emits `channelConfigs` so OpenClaw's setup driver picks up our channel without a metadata warning.

## 0.6.4 — 2026-04-27

- Fixed: install-time persist step now writes a complete channel config block on first install.

## 0.6.3 — 2026-04-27

- Internal: prepublish regression test for runtime-dependency spec shapes (rejects `workspace:` / `file:` / `link:` / `catalog:` protocols that don't survive raw-npm installs).

## 0.6.2 — 2026-04-25

- Packaging: prepublish hook strips workspace-only `package.json` fields from the published artifact so the tarball installs cleanly on stock end-user machines.

## 0.6.1 — 2026-04-25

- Internal: small refactor.

## 0.6.0 — 2026-04-25

- Internal: module reorganization across credential, runtime, and setup paths.

## 0.5.0 — 2026-04-23

- Discovery: registry listing metadata — title, tagline, icon, tag set.

## 0.4.0 — 2026-04-22

- Identity: agent handle reported into OpenClaw's identity prompt at session start so the agent self-introduces correctly in cold conversations.

## 0.3.0 — 2026-04-22

- Sync with server-side reference implementation; outbound and inbound adapters rebuilt against the canonical schema.

## 0.2.0 — 2026-04-20

- Setup wizard: register-vs-paste flow with email-OTP registration and live API-key validation.

## 0.1.0 — 2026-04-19

- Initial runtime: WebSocket transport, outbound adapter with idempotent send, inbound normalization, reconnect drain, circuit breaker.
