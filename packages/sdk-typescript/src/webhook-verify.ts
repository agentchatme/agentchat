import type { WebhookPayload } from './types/index.js'

/**
 * Raised when webhook signature verification fails. Always thrown with a
 * specific reason so handlers can log the cause without surfacing details
 * that might aid an attacker (e.g. "timestamp_skew" vs "bad_signature").
 * The error message stays deliberately terse — never log the raw body,
 * signature, or header with the error itself.
 */
export class WebhookVerificationError extends Error {
  readonly reason:
    | 'missing_signature'
    | 'malformed_signature'
    | 'timestamp_skew'
    | 'bad_signature'
    | 'malformed_payload'

  constructor(reason: WebhookVerificationError['reason'], message?: string) {
    super(message ?? reason)
    this.name = 'WebhookVerificationError'
    this.reason = reason
  }
}

export interface VerifyWebhookOptions {
  /** Raw request body, exactly as received. Do NOT JSON.parse first — the signature is over bytes. */
  payload: string | Uint8Array
  /**
   * Value of the signature header. Accepts two formats:
   *   - `t=<timestamp>,v1=<hex>` — Stripe-style, preferred
   *   - bare hex digest — assumes the body bytes were signed directly, no
   *     timestamp check possible
   */
  signature: string | null | undefined
  /** The webhook signing secret configured on your webhook endpoint. */
  secret: string
  /**
   * Maximum accepted skew between the signed timestamp and the current
   * wall-clock, in seconds. Default 300 (5 minutes) — the Stripe industry
   * norm. Pass 0 to disable the check (not recommended in production).
   */
  toleranceSeconds?: number
  /** Override for testing — defaults to `Date.now()`. */
  now?: () => number
}

/**
 * Verify an AgentChat webhook signature and return the parsed payload.
 *
 * Security-critical path — read carefully before changing:
 *
 * 1. Signature parsed from the header using a tolerant format
 *    (`t=…,v1=…`) that matches the documented wire shape. The `v1` scheme
 *    prefix lets us rotate to `v2` later without breaking old receivers.
 * 2. HMAC computed over `${timestamp}.${body}` with the caller's secret.
 * 3. Constant-time compare against the provided digest — a length-variance
 *    `===` compare would leak timing info about secret bytes.
 * 4. Timestamp check bounds replay windows. The default 5-minute
 *    tolerance is a deliberate trade between clock skew on the sender
 *    and replay resistance on the receiver.
 *
 * Returns the parsed `WebhookPayload` on success, throws
 * `WebhookVerificationError` on any failure (with `reason` set).
 */
export async function verifyWebhook(
  options: VerifyWebhookOptions,
): Promise<WebhookPayload> {
  const { payload, signature, secret, toleranceSeconds = 300 } = options
  const now = options.now ?? Date.now

  if (!signature) {
    throw new WebhookVerificationError('missing_signature')
  }

  const parsed = parseSignatureHeader(signature)
  const bodyString =
    typeof payload === 'string' ? payload : new TextDecoder().decode(payload)

  let expectedMessage: string
  if (parsed.timestamp !== null) {
    if (toleranceSeconds > 0) {
      const ageSeconds = Math.abs(now() / 1000 - parsed.timestamp)
      if (ageSeconds > toleranceSeconds) {
        throw new WebhookVerificationError('timestamp_skew')
      }
    }
    expectedMessage = `${parsed.timestamp}.${bodyString}`
  } else {
    // No timestamp — digest is over raw body.
    expectedMessage = bodyString
  }

  const computed = await hmacSha256Hex(secret, expectedMessage)
  if (!constantTimeEqual(computed, parsed.digest)) {
    throw new WebhookVerificationError('bad_signature')
  }

  try {
    const json = JSON.parse(bodyString) as WebhookPayload
    return json
  } catch {
    throw new WebhookVerificationError('malformed_payload')
  }
}

interface ParsedSignature {
  timestamp: number | null
  digest: string
}

function parseSignatureHeader(header: string): ParsedSignature {
  const trimmed = header.trim()

  // Shape 1: `t=123456789,v1=<hex>`. Order-insensitive; ignore unknown keys.
  if (trimmed.includes('=')) {
    const parts = trimmed.split(',')
    let timestamp: number | null = null
    let digest: string | null = null
    for (const p of parts) {
      const idx = p.indexOf('=')
      if (idx <= 0) continue
      const key = p.slice(0, idx).trim()
      const value = p.slice(idx + 1).trim()
      if (key === 't') {
        const n = Number(value)
        if (Number.isFinite(n)) timestamp = n
      } else if (key === 'v1') {
        digest = value.toLowerCase()
      }
    }
    if (!digest || !/^[a-f0-9]+$/.test(digest)) {
      throw new WebhookVerificationError('malformed_signature')
    }
    return { timestamp, digest }
  }

  // Shape 2: bare hex — treat body as the signed message.
  const digest = trimmed.toLowerCase()
  if (!/^[a-f0-9]+$/.test(digest)) {
    throw new WebhookVerificationError('malformed_signature')
  }
  return { timestamp: null, digest }
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle
  if (!subtle) {
    throw new WebhookVerificationError(
      'bad_signature',
      'Web Crypto API not available in this runtime; webhook verification requires `globalThis.crypto.subtle`.',
    )
  }
  const enc = new TextEncoder()
  const key = await subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await subtle.sign('HMAC', key, enc.encode(message))
  const bytes = new Uint8Array(sig)
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}

/**
 * Constant-time comparison of two hex strings. Returns `false` immediately
 * for mismatched lengths (a length check is not a timing leak — the
 * hex-length of a SHA-256 output is always 64, so length variance only
 * arises from a malformed signature).
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return mismatch === 0
}
