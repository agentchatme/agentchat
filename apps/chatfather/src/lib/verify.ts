import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Verify an AgentChat webhook signature.
 *
 * Wire format (matches apps/api-server/src/services/webhook-worker.ts):
 *   Header: X-AgentChat-Signature: <hex HMAC-SHA256(raw body, secret)>
 *
 * A plain hex digest — not the Stripe-style `t=…,v1=…` form. That means
 * we can't do a timestamp-replay check here, and we rely on the
 * delivery-id idempotency gate (24h SETNX) to catch replays within the
 * retry window. An attacker who captures a signed webhook can't replay
 * it because the delivery_id is already persisted; they also can't forge
 * a new one without the secret.
 *
 * Security notes:
 *   1. HMAC is computed over the RAW body bytes, not the parsed JSON.
 *      JSON.parse + JSON.stringify would re-order keys or change
 *      whitespace and break verification. Callers must pass
 *      `await c.req.text()` (or the equivalent raw body), NEVER
 *      `JSON.stringify(await c.req.json())`.
 *   2. `timingSafeEqual` requires equal-length inputs. We hex-compare
 *      against a 64-char SHA-256 digest; any header that can't produce
 *      a 64-char hex is rejected early with `false`. The length check
 *      itself is not a timing leak — hex digests are always 64 chars.
 *   3. `createHmac` key material is the secret as a UTF-8 string — the
 *      sender side also passes the secret as a string to createHmac,
 *      so the byte representation is identical.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false
  const provided = signatureHeader.trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(provided)) return false

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
  // Buffers of identical length — the regex above guarantees the provided
  // side is 64 chars, and SHA-256 hex is always 64 chars, so the compare
  // is safe.
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
