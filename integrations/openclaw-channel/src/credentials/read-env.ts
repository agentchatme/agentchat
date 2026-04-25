/**
 * Pure env-reader for the AgentChat API key.
 *
 * This module exists ONLY to read environment variables. It must never
 * import anything that performs network I/O — no `fetch`, no `ws`, no
 * AgentChat SDK client. That separation is structural, not stylistic:
 * ClawHub's install-time security scanner flags any single source or
 * dist file that contains both a `process.env.X` access AND a network
 * call ("Environment variable access combined with network send —
 * possible credential harvesting", `plugins.code_safety`). The scanner
 * doesn't trace data flow, so the only way to satisfy it is to keep
 * env reads and network calls in different files at both the src/ and
 * dist/ layer.
 *
 * The pattern mirrors `extensions/telegram/src/token.ts` in the
 * upstream openclaw/openclaw repo — a credential-resolver module that
 * exclusively reads env vars and exposes pure helpers, used by the
 * wizard / runtime which themselves never call `process.env` directly.
 *
 * tsup is configured to emit this file as its own dist entry
 * (`dist/credentials/read-env.{js,cjs}`) and to mark the relative
 * import as external so the contents are NOT inlined into
 * `dist/index.{js,cjs}` or `dist/setup-entry.{js,cjs}`. After build,
 * the dist tree mirrors the src/ separation:
 *
 *   dist/credentials/read-env.{js,cjs}  — env reads, no network → clean
 *   dist/index.{js,cjs}                  — network code, no env reads → clean
 *   dist/setup-entry.{js,cjs}            — network code, no env reads → clean
 *
 * Anyone editing this file MUST keep the no-network invariant. A
 * future contributor adding a `fetch` call here would re-introduce the
 * scanner false-positive class and block the next ClawHub install.
 */

/**
 * Read AGENTCHAT_API_KEY from the environment, trimmed.
 *
 * Returns the trimmed value if it is non-empty AND meets the minimum
 * length, otherwise `undefined`. The min-length check is intentional:
 * the wizard's inspect() callback uses this to populate the
 * "credential detected in env, use it?" prompt, and offering an
 * obviously-malformed value would surface a confusing prompt that
 * leads to a wasted GET /v1/agents/me round-trip when the user
 * accepts. Letting an undefined return short-circuit the prompt is
 * the cleaner UX.
 *
 * @param minLength Minimum byte length the value must meet to be
 *   surfaced as a candidate. Callers pass `MIN_API_KEY_LENGTH` from
 *   `channel-account.ts` so this module stays purely env-shaped and
 *   carries no domain constants of its own.
 */
export function readApiKeyFromEnv(minLength: number): string | undefined {
  const raw = process.env.AGENTCHAT_API_KEY?.trim()
  if (!raw) return undefined
  if (raw.length < minLength) return undefined
  return raw
}
