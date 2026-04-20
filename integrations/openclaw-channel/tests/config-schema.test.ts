import { describe, expect, it } from 'vitest'
import { parseChannelConfig } from '../src/config-schema.js'

const MIN_KEY = 'ac_live_' + 'x'.repeat(20)

describe('config schema — minimal accept', () => {
  it('accepts the minimal valid config (apiKey only)', () => {
    const cfg = parseChannelConfig({ apiKey: MIN_KEY })
    expect(cfg.apiKey).toBe(MIN_KEY)
    expect(cfg.apiBase).toBe('https://api.agentchat.me')
    expect(cfg.reconnect.initialBackoffMs).toBe(1_000)
    expect(cfg.ping.intervalMs).toBe(30_000)
    expect(cfg.outbound.maxInFlight).toBe(256)
    expect(cfg.observability.logLevel).toBe('info')
  })

  it('accepts a full config with overrides', () => {
    const cfg = parseChannelConfig({
      apiBase: 'https://staging.agentchat.me',
      apiKey: MIN_KEY,
      agentHandle: 'my-agent',
      reconnect: { initialBackoffMs: 500, maxBackoffMs: 60_000, jitterRatio: 0.5 },
      ping: { intervalMs: 45_000, timeoutMs: 5_000 },
      outbound: { maxInFlight: 1024, sendTimeoutMs: 30_000 },
      observability: { logLevel: 'debug', redactKeys: ['apiKey', 'token'] },
    })
    expect(cfg.apiBase).toBe('https://staging.agentchat.me')
    expect(cfg.agentHandle).toBe('my-agent')
    expect(cfg.reconnect.jitterRatio).toBe(0.5)
    expect(cfg.outbound.maxInFlight).toBe(1024)
  })
})

describe('config schema — rejection cases', () => {
  it('rejects missing apiKey', () => {
    expect(() => parseChannelConfig({})).toThrow()
  })

  it('rejects apiKey that is too short', () => {
    expect(() => parseChannelConfig({ apiKey: 'short' })).toThrow(/too short/)
  })

  it('rejects non-URL apiBase', () => {
    expect(() => parseChannelConfig({ apiKey: MIN_KEY, apiBase: 'not-a-url' })).toThrow()
  })

  it('rejects invalid agent handle', () => {
    expect(() => parseChannelConfig({ apiKey: MIN_KEY, agentHandle: 'ab' })).toThrow()
    expect(() =>
      parseChannelConfig({ apiKey: MIN_KEY, agentHandle: 'UPPERCASE' }),
    ).toThrow()
    expect(() =>
      parseChannelConfig({ apiKey: MIN_KEY, agentHandle: 'has spaces' }),
    ).toThrow()
  })

  it('rejects out-of-range backoff', () => {
    expect(() =>
      parseChannelConfig({ apiKey: MIN_KEY, reconnect: { initialBackoffMs: 50 } }),
    ).toThrow()
    expect(() =>
      parseChannelConfig({ apiKey: MIN_KEY, reconnect: { maxBackoffMs: 999 } }),
    ).toThrow()
  })

  it('rejects unknown top-level keys (strict mode)', () => {
    expect(() => parseChannelConfig({ apiKey: MIN_KEY, unknownField: 1 })).toThrow()
  })

  it('rejects invalid log level', () => {
    expect(() =>
      parseChannelConfig({ apiKey: MIN_KEY, observability: { logLevel: 'verbose' } }),
    ).toThrow()
  })
})
