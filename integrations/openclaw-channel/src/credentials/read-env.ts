/**
 * Reads the AgentChat API key from the host environment.
 *
 * Lives in its own module by design. See SECURITY.md ("Defensive
 * separation of credential lookup from outbound I/O") for the
 * architectural rationale and the invariants this file must keep.
 *
 * Returns the trimmed value when it is non-empty AND meets the minimum
 * length, otherwise `undefined`. The min-length argument is supplied
 * by the caller (currently `MIN_API_KEY_LENGTH` from
 * `channel-account.ts`) so this module owns no domain constants.
 */
export function readApiKeyFromEnv(minLength: number): string | undefined {
  const raw = process.env.AGENTCHAT_API_KEY?.trim()
  if (!raw) return undefined
  if (raw.length < minLength) return undefined
  return raw
}
