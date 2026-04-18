import { randomBytes } from 'node:crypto'

// ─── Prefixed id generator ─────────────────────────────────────────────────
//
// Mirrors apps/api-server/src/lib/id.ts. Each service owns its own copy
// rather than depending on a shared one — ids are opaque strings outside
// the issuing service's storage, so there's no cross-service contract to
// keep in sync. 12 bytes (96 bits) base64url-encoded gives 16 chars of
// collision-resistant suffix.
//
// Current chatfather prefixes:
//   esc — support_escalations.id (migration 041)

type Prefix = 'esc'

export function generateId(prefix: Prefix): string {
  const bytes = randomBytes(12)
  return `${prefix}_${bytes.toString('base64url')}`
}
