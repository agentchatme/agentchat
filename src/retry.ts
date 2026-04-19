/**
 * Retry + circuit-breaker primitives for outbound AgentChat API calls.
 *
 * Why not just use the SDK's retry policy?
 *   - The SDK's retry is a "best-effort per-request" policy: a 429 triggers
 *     a bounded delay, a 5xx triggers exponential backoff, done. That works
 *     for a CLI tool or one-shot send.
 *   - A channel plugin runs continuously and must degrade gracefully under
 *     sustained failure: if the API is down for 60 seconds, we should stop
 *     hammering it, open a circuit, and let a background probe close it
 *     back when it recovers. Without this, a dead API becomes a retry
 *     storm that multiplies every outbound send by the full retry budget.
 *
 * This module provides two orthogonal pieces:
 *   - `retryWithPolicy(fn, policy, classify)` — a typed exponential-backoff
 *     retry wrapper that respects `AgentChatChannelError.retryAfterMs` from
 *     429 responses and stops retrying immediately on terminal classes.
 *   - `CircuitBreaker` — classic half-open pattern. After `failureThreshold`
 *     consecutive transient failures inside `windowMs`, the circuit opens
 *     for `cooldownMs`. Subsequent calls fast-fail as `circuit-open`. After
 *     cooldown, one probe request is allowed; success closes, failure
 *     re-opens for another cooldown.
 *
 * Both are pure; they take a clock + random source so tests drive them
 * deterministically without fake timers.
 */

import { AgentChatChannelError, type ErrorClass } from './errors.js'
import type { UnixMillis } from './types.js'

// ─── Retry policy ──────────────────────────────────────────────────────

export interface RetryPolicy {
  readonly maxAttempts: number
  readonly initialBackoffMs: number
  readonly maxBackoffMs: number
  readonly jitterRatio: number
  /** Clock source. Default: Date.now. */
  readonly now?: () => UnixMillis
  /** Random source for jitter. Default: Math.random. */
  readonly random?: () => number
  /** Sleep implementation. Default: setTimeout-based. */
  readonly sleep?: (ms: number) => Promise<void>
}

export interface RetryOutcome<T> {
  readonly result: T
  readonly attempts: number
  readonly totalDelayMs: number
}

/** Default sleep — replaceable by tests via the policy.sleep override. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Execute `fn` with retry. Returns the successful result + attempt count.
 * Throws the last error if all attempts exhaust.
 *
 * Retry rules:
 *   - Error classes `terminal-auth`, `terminal-user`, `validation` throw
 *     immediately without retry.
 *   - `idempotent-replay` is treated as success by the caller, not this
 *     layer — caller converts it before throwing.
 *   - `retry-rate` uses the server-provided `retryAfterMs` when present,
 *     else the jittered exponential backoff.
 *   - `retry-transient` always uses jittered exponential.
 */
export async function retryWithPolicy<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
): Promise<RetryOutcome<T>> {
  const random = policy.random ?? Math.random
  const sleep = policy.sleep ?? defaultSleep
  let totalDelayMs = 0
  let lastErr: unknown

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      const result = await fn(attempt)
      return { result, attempts: attempt, totalDelayMs }
    } catch (err) {
      lastErr = err
      if (!(err instanceof AgentChatChannelError)) {
        throw err
      }
      if (isTerminalClass(err.class_)) {
        throw err
      }
      if (attempt >= policy.maxAttempts) {
        throw err
      }
      const delay = backoffDelay({
        attempt,
        errorClass: err.class_,
        retryAfterMs: err.retryAfterMs,
        policy,
        random,
      })
      totalDelayMs += delay
      await sleep(delay)
    }
  }
  throw lastErr
}

function isTerminalClass(class_: ErrorClass): boolean {
  // `idempotent-replay` is surfaced as a "do-not-retry" signal: the server
  // has already persisted a message with this client_msg_id (either from
  // this or a concurrent caller). Retrying won't help — the caller needs
  // to treat the original message as the canonical one.
  return (
    class_ === 'terminal-auth' ||
    class_ === 'terminal-user' ||
    class_ === 'validation' ||
    class_ === 'idempotent-replay'
  )
}

interface BackoffInput {
  attempt: number
  errorClass: ErrorClass
  retryAfterMs: number | undefined
  policy: RetryPolicy
  random: () => number
}

function backoffDelay({ attempt, errorClass, retryAfterMs, policy, random }: BackoffInput): number {
  // 429 with server-provided hint: obey it exactly (plus a small jitter so
  // a synchronized fleet doesn't all wake at the exact same instant).
  if (errorClass === 'retry-rate' && typeof retryAfterMs === 'number') {
    const jitter = 1 + random() * policy.jitterRatio
    return Math.min(policy.maxBackoffMs, Math.floor(retryAfterMs * jitter))
  }
  const exp = policy.initialBackoffMs * Math.pow(2, Math.min(attempt - 1, 20))
  const capped = Math.min(exp, policy.maxBackoffMs)
  const jitter = 1 - policy.jitterRatio + random() * 2 * policy.jitterRatio
  return Math.max(0, Math.floor(capped * jitter))
}

// ─── Circuit breaker ───────────────────────────────────────────────────

export type CircuitState = 'closed' | 'open' | 'half-open'

export interface CircuitBreakerOptions {
  readonly failureThreshold: number
  /** Open the circuit when `failureThreshold` failures occur inside this window. */
  readonly windowMs: number
  readonly cooldownMs: number
  readonly now?: () => UnixMillis
}

export interface CircuitSnapshot {
  readonly state: CircuitState
  readonly recentFailures: number
  readonly openedAt: UnixMillis | null
  readonly halfOpenAt: UnixMillis | null
}

/**
 * Single-process circuit breaker. Not distributed — each channel instance
 * has its own view. For a multi-instance deployment, the open-circuit
 * signal is observable via metrics (each instance emits `circuit_state`)
 * but each instance must independently detect the outage.
 */
export class CircuitBreaker {
  private readonly opts: CircuitBreakerOptions
  private readonly now: () => UnixMillis
  private state: CircuitState = 'closed'
  private failureTimestamps: UnixMillis[] = []
  private openedAt: UnixMillis | null = null
  private halfOpenAt: UnixMillis | null = null

  constructor(opts: CircuitBreakerOptions) {
    this.opts = opts
    this.now = opts.now ?? Date.now
  }

  snapshot(): CircuitSnapshot {
    return {
      state: this.state,
      recentFailures: this.failureTimestamps.length,
      openedAt: this.openedAt,
      halfOpenAt: this.halfOpenAt,
    }
  }

  /**
   * Check state at call time.
   *   - `closed` / `half-open` → returns `{ allow: true }`. Caller must
   *     invoke `onSuccess()` / `onFailure()` after the attempt.
   *   - `open` → returns `{ allow: false, reason }` so the caller can
   *     fast-fail without making the network call. If the cooldown has
   *     elapsed, transitions to `half-open` first and allows one probe.
   */
  precheck(): { allow: true } | { allow: false; reason: string } {
    if (this.state === 'open') {
      const now = this.now()
      const elapsed = now - (this.openedAt ?? now)
      if (elapsed >= this.opts.cooldownMs) {
        this.state = 'half-open'
        this.halfOpenAt = now
        return { allow: true }
      }
      return { allow: false, reason: 'circuit open — API appears unhealthy' }
    }
    return { allow: true }
  }

  onSuccess(): void {
    if (this.state === 'half-open') {
      this.state = 'closed'
      this.openedAt = null
      this.halfOpenAt = null
    }
    this.failureTimestamps = []
  }

  /**
   * Record a failure. Only transient classes count toward the breaker —
   * terminal-auth/terminal-user/validation failures are caller bugs or
   * server contract violations, not "API down" signals.
   */
  onFailure(errorClass: ErrorClass): void {
    if (isTerminalClass(errorClass)) return

    const now = this.now()

    if (this.state === 'half-open') {
      // Probe failed — re-open immediately.
      this.state = 'open'
      this.openedAt = now
      this.halfOpenAt = null
      return
    }

    this.failureTimestamps.push(now)
    this.trimOldFailures(now)

    if (this.failureTimestamps.length >= this.opts.failureThreshold) {
      this.state = 'open'
      this.openedAt = now
    }
  }

  private trimOldFailures(now: UnixMillis): void {
    const cutoff = now - this.opts.windowMs
    let firstFresh = 0
    while (
      firstFresh < this.failureTimestamps.length &&
      this.failureTimestamps[firstFresh]! < cutoff
    ) {
      firstFresh++
    }
    if (firstFresh > 0) this.failureTimestamps.splice(0, firstFresh)
  }
}
