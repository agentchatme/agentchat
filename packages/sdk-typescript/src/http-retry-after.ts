/**
 * Parses `Retry-After` per RFC 9110:
 *   - Non-negative integer → seconds from now
 *   - HTTP-date → absolute point in time
 *
 * Returns milliseconds, or `null` for missing / malformed input. Kept in
 * its own module to break the circular dependency between `http.ts` and
 * `errors.ts` — both need it but cannot import each other.
 */
export function parseRetryAfter(raw: string | null | undefined): number | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  // Prefer the integer-seconds form (`/^\d+$/` excludes `60s`, `1.5`,
  // negatives, and scientific notation).
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed)
    return Number.isFinite(seconds) ? seconds * 1000 : null
  }

  // HTTP-date formats per RFC 7231 all contain alphabetic characters (day-
  // of-week or month names). Requiring at least one alpha shields us from
  // Date.parse's liberal fallbacks — "1.5", "-1", and other stray numerics
  // would otherwise coerce into surprising epochs on some V8 builds.
  if (!/[a-zA-Z]/.test(trimmed)) return null
  const epoch = Date.parse(trimmed)
  if (!Number.isFinite(epoch)) return null
  return Math.max(0, epoch - Date.now())
}
