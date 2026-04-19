import { describe, expect, it } from 'vitest'
import {
  AgentChatChannelError,
  classifyHttpStatus,
  classifyNetworkError,
  isRetryable,
  isTerminal,
  parseRetryAfter,
} from '../src/errors.js'

describe('classifyHttpStatus', () => {
  it('maps 401/403 to terminal-auth', () => {
    expect(classifyHttpStatus(401)).toBe('terminal-auth')
    expect(classifyHttpStatus(403)).toBe('terminal-auth')
  })
  it('maps 409 to idempotent-replay', () => {
    expect(classifyHttpStatus(409)).toBe('idempotent-replay')
  })
  it('maps 429 to retry-rate', () => {
    expect(classifyHttpStatus(429)).toBe('retry-rate')
  })
  it('maps 5xx to retry-transient', () => {
    expect(classifyHttpStatus(500)).toBe('retry-transient')
    expect(classifyHttpStatus(503)).toBe('retry-transient')
    expect(classifyHttpStatus(599)).toBe('retry-transient')
  })
  it('maps other 4xx to terminal-user', () => {
    expect(classifyHttpStatus(400)).toBe('terminal-user')
    expect(classifyHttpStatus(422)).toBe('terminal-user')
  })
})

describe('parseRetryAfter', () => {
  const NOW = 1_700_000_000_000

  it('parses seconds', () => {
    expect(parseRetryAfter('5', NOW)).toBe(5_000)
    expect(parseRetryAfter('0', NOW)).toBe(0)
  })
  it('parses HTTP-date', () => {
    const future = new Date(NOW + 10_000).toUTCString()
    const ms = parseRetryAfter(future, NOW)
    expect(ms).toBeGreaterThanOrEqual(9_000)
    expect(ms).toBeLessThanOrEqual(10_000)
  })
  it('returns undefined on invalid input', () => {
    expect(parseRetryAfter(null, NOW)).toBeUndefined()
    expect(parseRetryAfter('', NOW)).toBeUndefined()
    expect(parseRetryAfter('not-a-date', NOW)).toBeUndefined()
  })
  it('clamps negative HTTP-dates to 0', () => {
    const past = new Date(NOW - 10_000).toUTCString()
    expect(parseRetryAfter(past, NOW)).toBe(0)
  })
})

describe('classifyNetworkError', () => {
  it('classifies ECONNRESET as retry-transient', () => {
    expect(classifyNetworkError({ code: 'ECONNRESET' })).toBe('retry-transient')
  })
  it('classifies ETIMEDOUT as retry-transient', () => {
    expect(classifyNetworkError({ code: 'ETIMEDOUT' })).toBe('retry-transient')
  })
  it('classifies unknown errors as retry-transient (safe default)', () => {
    expect(classifyNetworkError(new Error('boom'))).toBe('retry-transient')
    expect(classifyNetworkError(null)).toBe('retry-transient')
  })
})

describe('isRetryable / isTerminal guards', () => {
  it('retry-rate and retry-transient are retryable', () => {
    expect(isRetryable('retry-rate')).toBe(true)
    expect(isRetryable('retry-transient')).toBe(true)
  })
  it('terminal-auth / terminal-user / validation are terminal', () => {
    expect(isTerminal('terminal-auth')).toBe(true)
    expect(isTerminal('terminal-user')).toBe(true)
    expect(isTerminal('validation')).toBe(true)
  })
  it('idempotent-replay is neither retryable nor terminal (treated as success)', () => {
    expect(isRetryable('idempotent-replay')).toBe(false)
    expect(isTerminal('idempotent-replay')).toBe(false)
  })
})

describe('AgentChatChannelError', () => {
  it('preserves class, message, retryAfterMs, statusCode, cause', () => {
    const cause = new Error('root')
    const err = new AgentChatChannelError('retry-rate', 'rate limited', {
      cause,
      retryAfterMs: 5_000,
      statusCode: 429,
    })
    expect(err.class_).toBe('retry-rate')
    expect(err.message).toBe('rate limited')
    expect(err.retryAfterMs).toBe(5_000)
    expect(err.statusCode).toBe(429)
    expect(err.cause).toBe(cause)
    expect(err.name).toBe('AgentChatChannelError')
  })
})
