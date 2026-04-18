import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { parseRetryAfter } from '../src/http-retry-after.js'

describe('parseRetryAfter', () => {
  it('parses integer seconds', () => {
    expect(parseRetryAfter('5')).toBe(5000)
    expect(parseRetryAfter('60')).toBe(60_000)
    expect(parseRetryAfter('0')).toBe(0)
  })

  it('returns null for missing / empty', () => {
    expect(parseRetryAfter(null)).toBeNull()
    expect(parseRetryAfter(undefined)).toBeNull()
    expect(parseRetryAfter('')).toBeNull()
    expect(parseRetryAfter('   ')).toBeNull()
  })

  it('returns null for malformed numeric forms', () => {
    expect(parseRetryAfter('60s')).toBeNull()
    expect(parseRetryAfter('1.5')).toBeNull()
    expect(parseRetryAfter('-1')).toBeNull()
  })

  it('parses HTTP-date to a non-negative delta', () => {
    vi.useFakeTimers()
    const fixed = new Date('2026-01-15T12:00:00Z')
    vi.setSystemTime(fixed)

    const twoMinutesLater = new Date(fixed.getTime() + 120_000).toUTCString()
    expect(parseRetryAfter(twoMinutesLater)).toBe(120_000)

    const inThePast = new Date(fixed.getTime() - 10_000).toUTCString()
    expect(parseRetryAfter(inThePast)).toBe(0)

    vi.useRealTimers()
  })

  it('returns null for unparseable strings', () => {
    expect(parseRetryAfter('not-a-date')).toBeNull()
  })
})

afterEach(() => {
  vi.useRealTimers()
})
beforeEach(() => {
  vi.useRealTimers()
})
