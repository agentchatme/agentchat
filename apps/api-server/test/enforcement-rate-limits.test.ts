import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  GLOBAL_RATE_LIMIT_PER_SECOND,
  GROUP_AGGREGATE_RATE_LIMIT_PER_SECOND,
} from '@agentchat/shared'

// ─── Fake Redis ────────────────────────────────────────────────────────────
// Mirrors the shape of idempotency.test.ts — just enough of the ioredis
// surface that enforcement.service.ts uses. Key state is per-key; we only
// model the ops the rate limiters actually call (incr, expire).

class FakeRedis {
  private counters = new Map<string, number>()
  private ttls = new Map<string, number>() // ms TTL set, informational only
  failNextCall = false

  private maybeFail() {
    if (this.failNextCall) {
      this.failNextCall = false
      throw new Error('redis unavailable')
    }
  }

  async incr(key: string): Promise<number> {
    this.maybeFail()
    const next = (this.counters.get(key) ?? 0) + 1
    this.counters.set(key, next)
    return next
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.maybeFail()
    this.ttls.set(key, seconds * 1000)
    return 1
  }

  // Test helpers — not part of the real client surface.
  expireCallsFor(key: string): number | undefined {
    return this.ttls.get(key)
  }

  clear() {
    this.counters.clear()
    this.ttls.clear()
    this.failNextCall = false
  }
}

const fakeRedis = new FakeRedis()

const sentryCaptureMessage = vi.fn()
const loggerWarn = vi.fn()

vi.mock('../src/lib/redis.js', () => ({
  getRedis: () => fakeRedis,
}))

vi.mock('../src/instrument.js', () => ({
  Sentry: {
    captureMessage: sentryCaptureMessage,
    captureException: vi.fn(),
  },
}))

vi.mock('../src/lib/logger.js', () => ({
  logger: {
    warn: loggerWarn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

// pubsub + db are transitively imported by enforcement.service.ts; stub
// them so the module loads without reaching for real infra.
vi.mock('../src/ws/pubsub.js', () => ({
  publishDisconnect: vi.fn(),
}))
vi.mock('@agentchat/db', () => ({
  countColdOutreaches: vi.fn(),
  countInitiatedBlocks: vi.fn(),
  countInitiatedReports: vi.fn(),
  setAgentStatus: vi.fn(),
}))

const {
  checkGlobalRateLimit,
  checkGroupAggregateRateLimit,
  _resetGroupAggregateAlertStateForTests,
} = await import('../src/services/enforcement.service.js')

// ─── checkGroupAggregateRateLimit ──────────────────────────────────────────

describe('checkGroupAggregateRateLimit', () => {
  beforeEach(() => {
    fakeRedis.clear()
    sentryCaptureMessage.mockClear()
    loggerWarn.mockClear()
    _resetGroupAggregateAlertStateForTests()
  })

  it('allows the first message and every message up to the cap', async () => {
    for (let i = 0; i < GROUP_AGGREGATE_RATE_LIMIT_PER_SECOND; i++) {
      const r = await checkGroupAggregateRateLimit('conv_alpha')
      expect(r.allowed).toBe(true)
      expect(r.retryAfterMs).toBeUndefined()
    }
  })

  it('blocks the N+1th message in the same second with a retryAfterMs hint', async () => {
    for (let i = 0; i < GROUP_AGGREGATE_RATE_LIMIT_PER_SECOND; i++) {
      await checkGroupAggregateRateLimit('conv_alpha')
    }
    const blocked = await checkGroupAggregateRateLimit('conv_alpha')
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterMs).toBeGreaterThanOrEqual(0)
    expect(blocked.retryAfterMs).toBeLessThanOrEqual(1000)
  })

  it('keeps per-conversation buckets independent — one busy group does not starve another', async () => {
    for (let i = 0; i < GROUP_AGGREGATE_RATE_LIMIT_PER_SECOND; i++) {
      await checkGroupAggregateRateLimit('conv_alpha')
    }
    // conv_alpha is at cap in this second; conv_beta is untouched and must
    // still succeed. This is the core property of the aggregate key: it is
    // scoped to conversation_id, nothing cross-group.
    const fresh = await checkGroupAggregateRateLimit('conv_beta')
    expect(fresh.allowed).toBe(true)
  })

  it("writes the conversation id into the Redis key — NOT the agent's id", async () => {
    // This is the whole reason the aggregate bucket is architecturally
    // distinct from the per-agent bucket. If this key format ever drifts,
    // the K-collusion protection silently disappears. Test pins the shape.
    await checkGroupAggregateRateLimit('conv_xyz')
    const second = Math.floor(Date.now() / 1000)
    const expectedKey = `ratelimit:groupbucket:conv_xyz:${second}`
    expect(fakeRedis.expireCallsFor(expectedKey)).toBe(3000)
  })

  it('sets the 3s TTL only on the first increment, not on every call', async () => {
    const spy = vi.spyOn(fakeRedis, 'expire')
    for (let i = 0; i < 5; i++) {
      await checkGroupAggregateRateLimit('conv_alpha')
    }
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  it('fails open when Redis is unavailable — a broken rate limiter must not block all sends', async () => {
    fakeRedis.failNextCall = true
    const r = await checkGroupAggregateRateLimit('conv_alpha')
    expect(r.allowed).toBe(true)
    expect(r.retryAfterMs).toBeUndefined()
  })
})

// ─── Group-aggregate Sentry alert ─────────────────────────────────────────

describe('checkGroupAggregateRateLimit — Sentry alert on sustained spikes', () => {
  beforeEach(() => {
    fakeRedis.clear()
    sentryCaptureMessage.mockClear()
    loggerWarn.mockClear()
    _resetGroupAggregateAlertStateForTests()
  })

  it('does not fire Sentry for a single cap hit (below the 30/min threshold)', async () => {
    for (let i = 0; i < GROUP_AGGREGATE_RATE_LIMIT_PER_SECOND + 1; i++) {
      await checkGroupAggregateRateLimit('conv_alpha')
    }
    expect(sentryCaptureMessage).not.toHaveBeenCalled()
  })

  it('fires exactly one Sentry alert when hits cross the per-minute threshold', async () => {
    // 31 over-cap hits in one window — the 31st (> 30 threshold) fires.
    // We need 31 BLOCKED calls, so that's (cap + 31) total calls in this
    // second. Keep it in a single second so the window-rollover branch
    // isn't exercised.
    const totalCalls = GROUP_AGGREGATE_RATE_LIMIT_PER_SECOND + 31
    for (let i = 0; i < totalCalls; i++) {
      await checkGroupAggregateRateLimit('conv_alpha')
    }
    expect(sentryCaptureMessage).toHaveBeenCalledTimes(1)
    const [msg, ctx] = sentryCaptureMessage.mock.calls[0]!
    expect(msg).toBe('group_aggregate_rate_limit_spike')
    expect(ctx.level).toBe('warning')
    expect(ctx.tags).toEqual({ component: 'enforcement', rule: 'group_aggregate' })
    expect(ctx.extra.most_recent_offender_conversation_id).toBe('conv_alpha')
    expect(ctx.extra.threshold_per_min).toBe(30)
  })

  it('honours the 5-minute cooldown — a sustained spike does not spam Sentry', async () => {
    // Drive hits well past threshold; only one Sentry capture expected
    // despite hundreds of over-cap events in the same alerting window.
    const totalCalls = GROUP_AGGREGATE_RATE_LIMIT_PER_SECOND + 200
    for (let i = 0; i < totalCalls; i++) {
      await checkGroupAggregateRateLimit('conv_alpha')
    }
    expect(sentryCaptureMessage).toHaveBeenCalledTimes(1)
  })

  it('also logs a structured warning alongside the Sentry capture', async () => {
    const totalCalls = GROUP_AGGREGATE_RATE_LIMIT_PER_SECOND + 31
    for (let i = 0; i < totalCalls; i++) {
      await checkGroupAggregateRateLimit('conv_alpha')
    }
    expect(loggerWarn).toHaveBeenCalledTimes(1)
    expect(loggerWarn.mock.calls[0]![1]).toBe('group_aggregate_rate_limit_spike')
  })
})

// ─── checkGlobalRateLimit (covered for symmetry / regression safety) ───────

describe('checkGlobalRateLimit', () => {
  beforeEach(() => {
    fakeRedis.clear()
  })

  it('allows every message up to the 60/sec cap', async () => {
    for (let i = 0; i < GLOBAL_RATE_LIMIT_PER_SECOND; i++) {
      const r = await checkGlobalRateLimit('agent_alpha')
      expect(r.allowed).toBe(true)
    }
  })

  it('blocks the N+1th with retryAfterMs hint', async () => {
    for (let i = 0; i < GLOBAL_RATE_LIMIT_PER_SECOND; i++) {
      await checkGlobalRateLimit('agent_alpha')
    }
    const blocked = await checkGlobalRateLimit('agent_alpha')
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterMs).toBeGreaterThanOrEqual(0)
    expect(blocked.retryAfterMs).toBeLessThanOrEqual(1000)
  })

  it('keeps per-agent buckets independent', async () => {
    for (let i = 0; i < GLOBAL_RATE_LIMIT_PER_SECOND; i++) {
      await checkGlobalRateLimit('agent_alpha')
    }
    const otherAgent = await checkGlobalRateLimit('agent_beta')
    expect(otherAgent.allowed).toBe(true)
  })

  it('fails open on Redis unavailability', async () => {
    fakeRedis.failNextCall = true
    const r = await checkGlobalRateLimit('agent_alpha')
    expect(r.allowed).toBe(true)
  })
})
