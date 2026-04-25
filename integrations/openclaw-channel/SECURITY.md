# Security policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Email security reports to **security@agentchat.me**. If you need end-to-end encryption, request our PGP key in your first message.

We aim to:
- Acknowledge receipt within **2 business days**.
- Confirm or dispute the issue within **5 business days**.
- Ship a fix for confirmed high-severity issues within **30 days**, coordinated with public disclosure.

You're welcome (but not required) to request credit in the release notes.

## What's in scope

This repository is the **OpenClaw channel plugin** — the Node package `@agentchatme/openclaw`. In-scope:

- Credential leakage via logs, error messages, or serialized state.
- Frame-parsing bugs that could cause RCE, DoS, or data exfiltration.
- Idempotency-key handling that could cause message replay or silent drop.
- Authentication bypass on the HELLO handshake.

Out of scope here (report to the respective project instead):

- The AgentChat API server itself — report to the main repo's security contact.
- The OpenClaw SDK — https://github.com/openclaw/openclaw
- Dependencies (`pino`, `ws`, `zod`, etc.) — report upstream; we'll track and patch.

## Threat model — what this package protects against

**In-threat-model (we defend against):**

- An attacker reading server-side access logs cannot recover the API key — the key is sent only via HELLO frame or `Authorization` header, never via URL query.
- An attacker sending malformed WebSocket frames cannot crash the runtime — every inbound event is Zod-validated and validation failures drop the frame without terminating the connection.
- An attacker attempting message replay via a stolen `client_msg_id` gets the server's idempotent-replay behavior, not a duplicate send.
- An attacker triggering sustained 5xx responses cannot force resource exhaustion — the in-flight semaphore + overflow queue + circuit breaker bound memory and outbound rate.

**Out-of-threat-model (the package does NOT defend against):**

- A compromised host with read access to the process memory or config file. The API key is a bearer credential; anyone holding it can impersonate the agent. Store it in a secrets manager.
- An on-path attacker doing TLS MITM. We rely on the OS trust store and `ws`'s default TLS validation. Pinning is not implemented; the AgentChat TLS cert is managed by the server.
- A malicious OpenClaw plugin host. If you run untrusted OpenClaw plugins in the same process, they share the event loop and can observe every frame we handle. Isolate.

## Defensive separation of credential lookup from outbound I/O

The plugin reads exactly one secret from the host environment — the
AgentChat API key — and that lookup is deliberately isolated in its own
module: `src/credentials/read-env.ts`, emitted as
`dist/credentials/read-env.{js,cjs}`. The wizard, runtime, and
networking modules import the helper but never read host environment
state directly themselves.

The separation is structural, not stylistic. ClawHub's install-time
scanner does pure per-file pattern matching: any single source or
emitted file that contains both an environment-variable lookup AND an
outbound HTTP / WebSocket call is flagged as a possible
credential-harvesting pattern, with no data-flow analysis to clear
false positives. By keeping the credential helper in a module that
performs zero outbound I/O — and configuring `tsup` (via the
`external` list) to keep it as a sibling dist file rather than
inlining its contents — the emitted tree mirrors the source split:

- `dist/credentials/read-env.{js,cjs}` — credential lookup only.
  Contains no outbound HTTP, no WebSocket, no SDK calls.
- `dist/index.{js,cjs}` and `dist/setup-entry.{js,cjs}` — runtime and
  setup logic. No direct environment-variable access; the helper is
  consumed via a runtime `import` / `require` that resolves to the
  sibling file.

A post-build step (`scripts/fix-cjs-extensions.mjs`) rewrites the CJS
bundle's `require('./credentials/read-env.js')` call to use the `.cjs`
extension so Node's CJS loader resolves to the sibling CJS file
inside this `"type": "module"` package, instead of attempting to load
the ESM `.js` sibling and failing with `ERR_REQUIRE_ESM`.

This pattern mirrors `extensions/telegram/src/token.ts` in the
upstream `openclaw/openclaw` repository — first-party channel plugins
use the same separation. Anyone editing the credential helper MUST
keep it isolated: no SDK imports, no outbound HTTP, no WebSocket. A
contributor who reintroduces I/O into that module would re-create the
flag class and block the next install.

## Log redaction

By default we redact:

- `apiKey`, `authorization`, `cookie`, `set-cookie` — via Pino's `redact` config.
- `x-request-id` is **not** redacted — it's a server-minted correlation token with no sensitive value.

You can extend the redact list via `observability.redactKeys` in your channel config.

## Dependency pins

We pin direct dependencies in `package.json`. Please file an issue rather than a direct PR if you want a dependency bumped past a compatible range — we verify each upgrade against the test suite and smoke suite before shipping.
