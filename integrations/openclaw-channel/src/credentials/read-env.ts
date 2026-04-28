/**
 * Environment variable readers — isolated from outbound networking.
 *
 * The wizard, runtime, and SDK consume the helpers below instead of
 * touching the host environment directly. The split keeps credential
 * lookup in a small audit-friendly module that imports nothing more
 * than its own typings: no SDK, no transport, no logging.
 *
 * See SECURITY.md ("Defensive separation of credential lookup from
 * outbound I/O") for the full rationale and the contract callers
 * must respect.
 */

/**
 * Reads the AgentChat API key from `AGENTCHAT_API_KEY`.
 *
 * Returns the trimmed value when non-empty AND meeting `minLength`,
 * otherwise `undefined`. The min-length is supplied by the caller
 * (`MIN_API_KEY_LENGTH` from `channel-account.ts`) so this module
 * owns no domain constants.
 */
export function readApiKeyFromEnv(minLength: number): string | undefined {
  const raw = process.env.AGENTCHAT_API_KEY?.trim()
  if (!raw) return undefined
  if (raw.length < minLength) return undefined
  return raw
}

/**
 * Reads `OPENCLAW_PROFILE` for workspace path resolution. Mirrors
 * OpenClaw's own logic in `dist/workspace-hhTlRYqM.js:49-55`:
 * non-default profile name → `~/.openclaw/workspace-${profile}`.
 *
 * Returns the trimmed profile name only when it is set AND not equal
 * to "default" (case-insensitive). Returns `undefined` otherwise so
 * callers can fall through to the bare default.
 */
export function readOpenClawProfileFromEnv(): string | undefined {
  const raw = process.env.OPENCLAW_PROFILE?.trim()
  if (!raw) return undefined
  if (raw.toLowerCase() === 'default') return undefined
  return raw
}
