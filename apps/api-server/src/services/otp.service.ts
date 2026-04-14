import { getRedis } from '../lib/redis.js'

/**
 * OTP rate-limit enforcement for the register / recover / rotate-key flows.
 *
 * Supabase Auth handles the actual code generation + email delivery + final
 * validation. This module sits in front and enforces three policies that
 * Supabase doesn't cover out of the box:
 *
 *   1. 60s per-email resend cooldown — stops someone spamming the send button
 *   2. 20/hour per-email send cap — stops the same email being burned as a
 *      free spam relay
 *   3. 5 verify attempts per pending_id — stops brute-force against the
 *      6-digit code space (1M possibilities)
 *
 * Pending TTL (10 minutes) is enforced separately by the `pending:*` Redis
 * key's own `ex:600`. Once the pending key evaporates the caller returns
 * EXPIRED, so we don't need a separate "code expiry" policy here.
 */

const SEND_COOLDOWN_SECONDS = 60
const SEND_HOURLY_CAP = 20
const HOUR_SECONDS = 3600
const PENDING_TTL_SECONDS = 600
const MAX_VERIFY_ATTEMPTS = 5

export class OtpRateError extends Error {
  code: string
  status: number
  retryAfterSeconds?: number

  constructor(code: string, message: string, status: number, retryAfterSeconds?: number) {
    super(message)
    this.name = 'OtpRateError'
    this.code = code
    this.status = status
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/**
 * Claim an OTP send slot for this email. Throws OtpRateError if the email
 * is inside its 60s cooldown or has exceeded 20/hr. Call BEFORE the email
 * send; call releaseOtpSendSlot() if the send fails after a successful
 * claim so the user isn't penalized for infrastructure flakiness.
 *
 * Fail-open on Redis errors — same trade-off as checkGlobalRateLimit.
 * Better to send a legitimate code during a Redis outage than to brick
 * account creation globally for the duration of it.
 */
export async function claimOtpSendSlot(email: string): Promise<void> {
  const redis = getRedis()
  const cooldownKey = `otp:send:cooldown:${email}`
  const hourlyKey = `otp:send:hourly:${email}`

  try {
    // Cooldown check first — if it's set, reject without touching the counter.
    const onCooldown = await redis.get<string>(cooldownKey)
    if (onCooldown) {
      let ttl = await redis.ttl(cooldownKey)
      if (ttl <= 0) ttl = SEND_COOLDOWN_SECONDS
      throw new OtpRateError(
        'OTP_COOLDOWN',
        `Please wait ${ttl}s before requesting another code.`,
        429,
        ttl,
      )
    }

    // Hourly cap — atomic increment, set TTL on first hit.
    const hourly = await redis.incr(hourlyKey)
    if (hourly === 1) {
      await redis.expire(hourlyKey, HOUR_SECONDS)
    }
    if (hourly > SEND_HOURLY_CAP) {
      // Don't roll back — letting the key stay pinned for the hour is the
      // intended behavior (each overage attempt keeps the counter high).
      const ttl = await redis.ttl(hourlyKey)
      throw new OtpRateError(
        'OTP_HOURLY_CAP',
        `Maximum ${SEND_HOURLY_CAP} verification codes per hour. Please try again later.`,
        429,
        ttl > 0 ? ttl : HOUR_SECONDS,
      )
    }

    // Arm the cooldown marker.
    await redis.set(cooldownKey, '1', { ex: SEND_COOLDOWN_SECONDS })
  } catch (err) {
    if (err instanceof OtpRateError) throw err
    // Redis down — fail open.
    console.error('[otp] claimOtpSendSlot Redis error:', err)
  }
}

/**
 * Release a previously-claimed send slot. Call this if Supabase rejects
 * the send AFTER claimOtpSendSlot succeeded — otherwise the user is locked
 * out of retrying for 60s because of our downstream failure.
 */
export async function releaseOtpSendSlot(email: string): Promise<void> {
  const redis = getRedis()
  try {
    await redis.del(`otp:send:cooldown:${email}`)
    // Roll back the hourly counter — best-effort, DECR below 0 is harmless
    // on Upstash because we only check `> SEND_HOURLY_CAP` on the next send.
    await redis.decr(`otp:send:hourly:${email}`)
  } catch (err) {
    console.error('[otp] releaseOtpSendSlot Redis error:', err)
  }
}

/**
 * Register a verify attempt against a specific pending_id. Throws after
 * the 5-attempt cap is hit, and also deletes the pending id from Redis
 * so subsequent tries return EXPIRED rather than letting the attacker
 * keep probing the code space.
 *
 * The pendingPrefix argument scopes the deletion correctly for each
 * caller — register uses `pending:`, recover uses `recover:`, rotation
 * uses `rotate:`. Without it we can't know which key to evict.
 */
export async function registerOtpVerifyAttempt(
  pendingId: string,
  pendingPrefix: 'pending:' | 'recover:' | 'rotate:' | 'dashboard:',
): Promise<void> {
  const redis = getRedis()
  const key = `otp:attempts:${pendingId}`

  try {
    const n = await redis.incr(key)
    if (n === 1) {
      await redis.expire(key, PENDING_TTL_SECONDS)
    }
    if (n > MAX_VERIFY_ATTEMPTS) {
      // Burn the pending — the attacker has used their 5 chances on this
      // code. They can request a new one (rate-limited by the send cap).
      await redis.del(`${pendingPrefix}${pendingId}`).catch(() => {})
      await redis.del(key).catch(() => {})
      throw new OtpRateError(
        'OTP_ATTEMPTS_EXHAUSTED',
        `Too many incorrect codes (max ${MAX_VERIFY_ATTEMPTS}). Please request a new one.`,
        429,
      )
    }
  } catch (err) {
    if (err instanceof OtpRateError) throw err
    // Redis flaky — fail open. Allowing an extra guess is cheaper than
    // blocking legitimate verification during an outage.
    console.error('[otp] registerOtpVerifyAttempt Redis error:', err)
  }
}

/** Clear the attempt counter after a successful verification. */
export async function clearOtpAttempts(pendingId: string): Promise<void> {
  const redis = getRedis()
  try {
    await redis.del(`otp:attempts:${pendingId}`)
  } catch {
    // Non-critical — it'll expire on its own.
  }
}
