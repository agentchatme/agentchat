/**
 * Tests for retry + circuit breaker primitives.
 *
 * These are pure (take clock/random/sleep as deps) so no fake-timers
 * needed — we pass a deterministic sleep that records calls.
 */

import { describe, it, expect } from 'vitest'
import { AgentChatChannelError } from '../src/errors.js'
import { CircuitBreaker, retryWithPolicy, type RetryPolicy } from '../src/retry.js'

function makePolicy(overrides: Partial<RetryPolicy> = {}): RetryPolicy & { sleptFor: number[] } {
  const sleptFor: number[] = []
  return {
    maxAttempts: 3,
    initialBackoffMs: 100,
    maxBackoffMs: 1000,
    jitterRatio: 0,
    random: () => 0.5,
    sleep: (ms) => {
      sleptFor.push(ms)
      return Promise.resolve()
    },
    sleptFor,
    ...overrides,
  } as RetryPolicy & { sleptFor: number[] }
}

describe('retryWithPolicy', () => {
  it('returns on first attempt success', async () => {
    const policy = makePolicy()
    const outcome = await retryWithPolicy(async () => 42, policy)
    expect(outcome.result).toBe(42)
    expect(outcome.attempts).toBe(1)
    expect(policy.sleptFor).toEqual([])
  })

  it('retries on retry-transient and eventually succeeds', async () => {
    const policy = makePolicy()
    let calls = 0
    const outcome = await retryWithPolicy(async () => {
      calls++
      if (calls < 3) throw new AgentChatChannelError('retry-transient', `fail ${calls}`)
      return 'ok'
    }, policy)
    expect(outcome.result).toBe('ok')
    expect(outcome.attempts).toBe(3)
    // Two sleeps between three attempts: 100 and 200 (exponential)
    expect(policy.sleptFor).toEqual([100, 200])
  })

  it('throws immediately on terminal-auth without retry', async () => {
    const policy = makePolicy()
    let calls = 0
    await expect(
      retryWithPolicy(async () => {
        calls++
        throw new AgentChatChannelError('terminal-auth', 'bad key')
      }, policy),
    ).rejects.toThrow(/bad key/)
    expect(calls).toBe(1)
    expect(policy.sleptFor).toEqual([])
  })

  it('throws immediately on terminal-user without retry', async () => {
    const policy = makePolicy()
    let calls = 0
    await expect(
      retryWithPolicy(async () => {
        calls++
        throw new AgentChatChannelError('terminal-user', 'validation error')
      }, policy),
    ).rejects.toThrow()
    expect(calls).toBe(1)
  })

  it('throws immediately on validation without retry', async () => {
    const policy = makePolicy()
    await expect(
      retryWithPolicy(async () => {
        throw new AgentChatChannelError('validation', 'bad schema')
      }, policy),
    ).rejects.toThrow()
    expect(policy.sleptFor).toEqual([])
  })

  it('honors Retry-After on retry-rate class', async () => {
    const policy = makePolicy()
    let calls = 0
    await retryWithPolicy(async () => {
      calls++
      if (calls === 1) {
        throw new AgentChatChannelError('retry-rate', '429', { retryAfterMs: 750 })
      }
      return 'ok'
    }, policy)
    // Retry-After honored exactly (no jitter with ratio 0).
    expect(policy.sleptFor).toEqual([750])
  })

  it('gives up after maxAttempts and throws last error', async () => {
    const policy = makePolicy({ maxAttempts: 2 })
    await expect(
      retryWithPolicy(async () => {
        throw new AgentChatChannelError('retry-transient', 'flaky')
      }, policy),
    ).rejects.toThrow(/flaky/)
    // Only one sleep between two attempts.
    expect(policy.sleptFor).toHaveLength(1)
  })

  it('rethrows non-AgentChatChannelError without retry', async () => {
    const policy = makePolicy()
    let calls = 0
    await expect(
      retryWithPolicy(async () => {
        calls++
        throw new Error('generic boom')
      }, policy),
    ).rejects.toThrow(/generic boom/)
    expect(calls).toBe(1)
  })

  it('caps backoff at maxBackoffMs', async () => {
    const policy = makePolicy({ initialBackoffMs: 100, maxBackoffMs: 300, maxAttempts: 5 })
    await expect(
      retryWithPolicy(async () => {
        throw new AgentChatChannelError('retry-transient', 'x')
      }, policy),
    ).rejects.toThrow()
    // Delays: 100, 200, 300 (capped), 300 (capped).
    expect(policy.sleptFor).toEqual([100, 200, 300, 300])
  })
})

describe('CircuitBreaker', () => {
  it('starts closed and allows calls', () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 3,
      windowMs: 1000,
      cooldownMs: 500,
    })
    expect(breaker.snapshot().state).toBe('closed')
    expect(breaker.precheck()).toEqual({ allow: true })
  })

  it('opens after failureThreshold transient failures', () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 3,
      windowMs: 10000,
      cooldownMs: 500,
    })
    breaker.onFailure('retry-transient')
    breaker.onFailure('retry-transient')
    expect(breaker.snapshot().state).toBe('closed')
    breaker.onFailure('retry-transient')
    expect(breaker.snapshot().state).toBe('open')
    expect(breaker.precheck().allow).toBe(false)
  })

  it('does not count terminal failures toward opening', () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      windowMs: 10000,
      cooldownMs: 500,
    })
    breaker.onFailure('terminal-auth')
    breaker.onFailure('terminal-user')
    breaker.onFailure('validation')
    expect(breaker.snapshot().state).toBe('closed')
  })

  it('transitions to half-open after cooldown', () => {
    let now = 0
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      windowMs: 10000,
      cooldownMs: 500,
      now: () => now,
    })
    breaker.onFailure('retry-transient')
    breaker.onFailure('retry-transient')
    expect(breaker.snapshot().state).toBe('open')
    expect(breaker.precheck().allow).toBe(false)
    now = 600
    const pre = breaker.precheck()
    expect(pre.allow).toBe(true)
    expect(breaker.snapshot().state).toBe('half-open')
  })

  it('closes on successful probe in half-open', () => {
    let now = 0
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      windowMs: 10000,
      cooldownMs: 100,
      now: () => now,
    })
    breaker.onFailure('retry-transient')
    now = 200
    breaker.precheck()
    expect(breaker.snapshot().state).toBe('half-open')
    breaker.onSuccess()
    expect(breaker.snapshot().state).toBe('closed')
  })

  it('re-opens on failed probe in half-open', () => {
    let now = 0
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      windowMs: 10000,
      cooldownMs: 100,
      now: () => now,
    })
    breaker.onFailure('retry-transient')
    now = 200
    breaker.precheck()
    breaker.onFailure('retry-transient')
    expect(breaker.snapshot().state).toBe('open')
  })

  it('forgets stale failures outside the window', () => {
    let now = 0
    const breaker = new CircuitBreaker({
      failureThreshold: 3,
      windowMs: 1000,
      cooldownMs: 500,
      now: () => now,
    })
    breaker.onFailure('retry-transient')
    breaker.onFailure('retry-transient')
    now = 2000
    breaker.onFailure('retry-transient')
    // Only the most recent failure is inside the window now.
    expect(breaker.snapshot().state).toBe('closed')
    expect(breaker.snapshot().recentFailures).toBe(1)
  })
})
