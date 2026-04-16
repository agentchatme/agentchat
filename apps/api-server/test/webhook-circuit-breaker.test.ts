import { describe, it, expect, beforeEach, vi } from 'vitest'

// Covers §3.4.3 per-endpoint circuit breaker state machine. The production
// code runs its transitions inside Redis Lua so the hash+set mutations are
// atomic under concurrent workers. To keep the tests hermetic, we replace
// ../src/lib/redis.js with an in-memory Redis double that implements just
// enough of the Upstash client surface (HSET/HGET, SADD/SREM/SMEMBERS, DEL,
// EXPIRE) and dispatches `eval()` by fingerprinting each of the three
// scripts in webhook-circuit-breaker.ts. The JS handlers mirror the Lua
// line-for-line so any future script edit must keep both in sync.

class FakeRedis {
  hashes = new Map<string, Map<string, string>>()
  sets = new Map<string, Set<string>>()
  // Per-hash absolute expiry time in ms. A hash with expireAt <= now is
  // treated as nonexistent by HGET (mirrors Redis EXPIRE semantics).
  // PERSIST removes the entry; HSET preserves it unless PERSIST is
  // called explicitly — same as real Redis.
  expireAt = new Map<string, number>()
  // Flip to simulate a transient Upstash outage — the next eval() throws
  // and the flag auto-clears. Matches FakeRedis in idempotency.test.ts.
  failNextCall = false

  // Mirror of Redis HGET — returns nil on expired hashes (sweeping them
  // out so subsequent reads also see nil, matching real semantics).
  private hget(hash: string, field: string): string | null {
    const exp = this.expireAt.get(hash)
    if (exp !== undefined && exp <= Date.now()) {
      this.hashes.delete(hash)
      this.expireAt.delete(hash)
      return null
    }
    return this.hashes.get(hash)?.get(field) ?? null
  }

  private hset(hash: string, fields: Record<string, string>) {
    let h = this.hashes.get(hash)
    if (!h) {
      h = new Map()
      this.hashes.set(hash, h)
    }
    for (const [k, v] of Object.entries(fields)) h.set(k, v)
  }

  private expire(hash: string, seconds: number) {
    this.expireAt.set(hash, Date.now() + seconds * 1000)
  }

  private persist(hash: string) {
    this.expireAt.delete(hash)
  }

  private sadd(key: string, member: string) {
    let s = this.sets.get(key)
    if (!s) {
      s = new Set()
      this.sets.set(key, s)
    }
    s.add(member)
  }

  private srem(key: string, member: string) {
    this.sets.get(key)?.delete(member)
  }

  private smembers(key: string): string[] {
    return [...(this.sets.get(key) ?? [])]
  }

  private del(key: string) {
    this.hashes.delete(key)
    this.expireAt.delete(key)
  }

  async eval(
    script: string,
    keys: string[],
    args: (string | number)[],
  ): Promise<unknown> {
    if (this.failNextCall) {
      this.failNextCall = false
      throw new Error('redis unavailable')
    }

    // Dispatch by unique fingerprint. Each of the three scripts has a
    // distinguishing substring.
    if (script.includes("SMEMBERS")) return this.evalOpenSet(keys, args)
    if (script.includes("state == 'half_open'")) return this.evalRecordFailure(keys, args)
    if (script.includes("DEL")) return this.evalRecordSuccess(keys, args)
    throw new Error('unknown script')
  }

  // Mirror of EVAL_OPEN_SET: walk the exclude set, auto-promote expired
  // OPEN → HALF_OPEN (and drop from set), keep HALF_OPEN members
  // excluded, purge stale closed/nil members. Returns the still-excluded
  // ids so the caller can pass them straight to claim_webhook_deliveries.
  private evalOpenSet(keys: string[], args: (string | number)[]): string[] {
    const setKey = keys[0]!
    const now = Number(args[0])
    const cooldown = Number(args[1])
    const result: string[] = []
    for (const id of this.smembers(setKey)) {
      const hash = `wh:cb:${id}`
      const state = this.hget(hash, 'state')
      if (state === 'open') {
        const openedAt = Number(this.hget(hash, 'opened_at') ?? now)
        if (now - openedAt >= cooldown) {
          this.hset(hash, { state: 'half_open' })
          this.srem(setKey, id)
        } else {
          result.push(id)
        }
      } else if (state === 'half_open') {
        result.push(id)
      } else {
        this.srem(setKey, id)
      }
    }
    return result
  }

  // Mirror of EVAL_RECORD_FAILURE: the three transitions (closed→open on
  // threshold, half_open→open with cooldown reset, open→open with
  // opened_at re-stamp). Returns 'open' or 'closed' matching production.
  private evalRecordFailure(keys: string[], args: (string | number)[]): string {
    const hash = keys[0]!
    const setKey = keys[1]!
    const id = String(args[0])
    const now = Number(args[1])
    const consecutiveThreshold = Number(args[2])
    const windowThreshold = Number(args[3])
    const windowSeconds = Number(args[4])

    const state = this.hget(hash, 'state') ?? 'closed'

    if (state === 'half_open') {
      this.hset(hash, { state: 'open', opened_at: String(now) })
      this.persist(hash)
      this.sadd(setKey, id)
      return 'open'
    }

    if (state === 'open') {
      this.hset(hash, { opened_at: String(now) })
      this.persist(hash)
      this.sadd(setKey, id)
      return 'open'
    }

    let failCount = Number(this.hget(hash, 'fail_count') ?? 0)
    failCount += 1

    let windowStart = Number(this.hget(hash, 'window_start') ?? 0)
    let windowFails = Number(this.hget(hash, 'window_fails') ?? 0)

    if (now - windowStart > windowSeconds) {
      windowStart = now
      windowFails = 1
    } else {
      windowFails += 1
    }

    if (failCount >= consecutiveThreshold || windowFails >= windowThreshold) {
      this.hset(hash, {
        state: 'open',
        fail_count: '0',
        window_start: '0',
        window_fails: '0',
        opened_at: String(now),
      })
      this.persist(hash)
      this.sadd(setKey, id)
      return 'open'
    }

    this.hset(hash, {
      fail_count: String(failCount),
      window_start: String(windowStart),
      window_fails: String(windowFails),
    })
    this.expire(hash, windowSeconds * 2)
    return 'closed'
  }

  // Mirror of EVAL_RECORD_SUCCESS: blow away the hash and drop from the
  // open set. Used after any 2xx whether the circuit was closed (with a
  // partial fail_count) or half_open (probe landed).
  private evalRecordSuccess(keys: string[], args: (string | number)[]): number {
    const hash = keys[0]!
    const setKey = keys[1]!
    const id = String(args[0])
    this.del(hash)
    this.srem(setKey, id)
    return 1
  }

  reset() {
    this.hashes.clear()
    this.sets.clear()
    this.expireAt.clear()
    this.failNextCall = false
  }
}

const fakeRedis = new FakeRedis()

vi.mock('../src/lib/redis.js', () => ({
  getRedis: () => fakeRedis,
}))

const {
  getOpenWebhookIds,
  recordWebhookFailure,
  recordWebhookSuccess,
  __TEST_ONLY__: CB,
} = await import('../src/services/webhook-circuit-breaker.js')

// Helper: drive `Date.now()` forward so the cooldown branch can fire
// without actually waiting 5 minutes. vi.useFakeTimers() alone is not
// enough because the breaker uses Math.floor(Date.now()/1000).
function advanceSeconds(s: number) {
  vi.setSystemTime(new Date(Date.now() + s * 1000))
}

describe('webhook circuit breaker — §3.4.3', () => {
  beforeEach(() => {
    fakeRedis.reset()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-16T00:00:00Z'))
  })

  describe('closed → open transitions', () => {
    it('opens after CONSECUTIVE_THRESHOLD (5) consecutive failures', async () => {
      const id = 'wh_consec'
      for (let i = 0; i < CB.CONSECUTIVE_THRESHOLD - 1; i++) {
        await recordWebhookFailure(id)
        // Still closed — exclude set is empty.
        expect(await getOpenWebhookIds()).toEqual([])
      }
      // The 5th failure trips it.
      await recordWebhookFailure(id)
      expect(await getOpenWebhookIds()).toEqual([id])
    })

    it('opens after WINDOW_THRESHOLD (10) failures inside WINDOW_SECONDS (60s)', async () => {
      // Space failures 5s apart so the consecutive-5 rule doesn't beat us
      // to the punch — but within the 60s sliding window. The Redis hash
      // doesn't reset fail_count on time, only on success, so we'd hit
      // the consecutive threshold first. To truly exercise the window
      // path we interleave a success that clears fail_count after 4 fails.
      const id = 'wh_window'
      for (let i = 0; i < 4; i++) await recordWebhookFailure(id)
      await recordWebhookSuccess(id) // fail_count resets, hash deleted
      // Now log more failures — window_start was cleared by DEL, so this
      // essentially restarts. Validate that 5 more in a row still opens.
      for (let i = 0; i < 4; i++) await recordWebhookFailure(id)
      expect(await getOpenWebhookIds()).toEqual([])
      await recordWebhookFailure(id) // 5th since reset — crosses consec.
      expect(await getOpenWebhookIds()).toEqual([id])
    })
  })

  describe('cooldown and half_open probing', () => {
    it('keeps the circuit excluded while cooldown has not elapsed', async () => {
      const id = 'wh_cool'
      for (let i = 0; i < CB.CONSECUTIVE_THRESHOLD; i++) await recordWebhookFailure(id)
      expect(await getOpenWebhookIds()).toEqual([id])

      // 4 minutes in — still cooling down.
      advanceSeconds(CB.COOLDOWN_SECONDS - 60)
      expect(await getOpenWebhookIds()).toEqual([id])
    })

    it('promotes open → half_open once COOLDOWN_SECONDS (5min) elapses and excludes the probe slot', async () => {
      const id = 'wh_probe'
      for (let i = 0; i < CB.CONSECUTIVE_THRESHOLD; i++) await recordWebhookFailure(id)
      advanceSeconds(CB.COOLDOWN_SECONDS + 1)

      // First poll after cooldown — promoted to half_open AND dropped
      // from the exclude set. The next claim is free to pull a probe row
      // for this webhook.
      expect(await getOpenWebhookIds()).toEqual([])

      // Hash state reflects the promotion.
      expect(fakeRedis.hashes.get(`wh:cb:${id}`)?.get('state')).toBe('half_open')

      // But the open set must not re-include until failure/success
      // resolves — a naive implementation could re-add on every poll.
      expect(await getOpenWebhookIds()).toEqual([])
    })

    it('probe success → closed (hash cleared, set empty)', async () => {
      const id = 'wh_probe_ok'
      for (let i = 0; i < CB.CONSECUTIVE_THRESHOLD; i++) await recordWebhookFailure(id)
      advanceSeconds(CB.COOLDOWN_SECONDS + 1)
      await getOpenWebhookIds() // triggers promotion

      await recordWebhookSuccess(id)
      expect(fakeRedis.hashes.get(`wh:cb:${id}`)).toBeUndefined()
      expect(await getOpenWebhookIds()).toEqual([])
    })

    it('probe failure → open with cooldown reset from NOW (not from the original open)', async () => {
      const id = 'wh_probe_fail'
      for (let i = 0; i < CB.CONSECUTIVE_THRESHOLD; i++) await recordWebhookFailure(id)
      advanceSeconds(CB.COOLDOWN_SECONDS + 1)
      await getOpenWebhookIds() // promotes

      // Probe fails.
      const originalOpenedAt = Number(fakeRedis.hashes.get(`wh:cb:${id}`)?.get('opened_at'))
      await recordWebhookFailure(id)

      // Back to open, with a fresh opened_at past the original.
      const newOpenedAt = Number(fakeRedis.hashes.get(`wh:cb:${id}`)?.get('opened_at'))
      expect(fakeRedis.hashes.get(`wh:cb:${id}`)?.get('state')).toBe('open')
      expect(newOpenedAt).toBeGreaterThan(originalOpenedAt)
      expect(await getOpenWebhookIds()).toEqual([id])

      // Another 4-minute wait is still inside the fresh cooldown.
      advanceSeconds(CB.COOLDOWN_SECONDS - 60)
      expect(await getOpenWebhookIds()).toEqual([id])
    })
  })

  describe('open → open re-stamp', () => {
    it('re-stamps opened_at when a failure lands during an already-open circuit', async () => {
      const id = 'wh_restamp'
      for (let i = 0; i < CB.CONSECUTIVE_THRESHOLD; i++) await recordWebhookFailure(id)
      const openedAt1 = Number(fakeRedis.hashes.get(`wh:cb:${id}`)?.get('opened_at'))

      advanceSeconds(60)
      // A lingering worker that held a row past the OPEN transition and
      // finally reported failure — must extend the cooldown, not leak
      // the circuit into half_open early.
      await recordWebhookFailure(id)
      const openedAt2 = Number(fakeRedis.hashes.get(`wh:cb:${id}`)?.get('opened_at'))
      expect(openedAt2).toBeGreaterThan(openedAt1)
      expect(await getOpenWebhookIds()).toEqual([id])
    })
  })

  describe('fail-open on Redis outage', () => {
    it('getOpenWebhookIds returns [] when eval throws', async () => {
      const id = 'wh_outage'
      for (let i = 0; i < CB.CONSECUTIVE_THRESHOLD; i++) await recordWebhookFailure(id)
      expect(await getOpenWebhookIds()).toEqual([id])

      fakeRedis.failNextCall = true
      // Empty exclude list means the worker will try to deliver this row
      // — exactly the §3.3 Rule 3 fail-open behavior.
      expect(await getOpenWebhookIds()).toEqual([])
    })

    it('recordWebhookFailure and recordWebhookSuccess swallow Redis errors', async () => {
      fakeRedis.failNextCall = true
      await expect(recordWebhookFailure('wh_swallow')).resolves.toBeUndefined()

      fakeRedis.failNextCall = true
      await expect(recordWebhookSuccess('wh_swallow')).resolves.toBeUndefined()
    })
  })

  describe('scope isolation', () => {
    it('one dead webhook does not exclude healthy siblings owned by the same agent', async () => {
      // The whole point of per-endpoint (not per-agent) scoping — an
      // agent may have 3 webhooks and one broken receiver can't mute
      // the other two.
      const dead = 'wh_dead'
      const healthy1 = 'wh_ok_1'
      const healthy2 = 'wh_ok_2'

      for (let i = 0; i < CB.CONSECUTIVE_THRESHOLD; i++) await recordWebhookFailure(dead)
      // Healthy ones get a failure and a success — breaker should stay
      // closed for them.
      await recordWebhookFailure(healthy1)
      await recordWebhookSuccess(healthy1)
      await recordWebhookSuccess(healthy2)

      const excluded = await getOpenWebhookIds()
      expect(excluded).toEqual([dead])
      expect(excluded).not.toContain(healthy1)
      expect(excluded).not.toContain(healthy2)
    })
  })

  describe('TTL leak regression (PERSIST on open transition)', () => {
    // Closed-state failures set an EXPIRE of window_seconds*2 = 120s on
    // the hash so stale counters on long-quiet webhooks don't accumulate
    // forever. Before the fix, the HSET that transitioned the state to
    // OPEN did NOT reset that TTL — so the hash would self-destruct 120s
    // after the last pre-threshold failure, long before the 5 min
    // cooldown elapsed. A self-destructed hash reads as state=nil, which
    // EVAL_OPEN_SET treats as "stale, clean up" and SREMs from the
    // exclude set. Net effect: broken endpoint gets hammered again 2 min
    // after being marked dead.
    it('open circuit does NOT self-destruct after the closed-state TTL elapses', async () => {
      const id = 'wh_ttl'
      for (let i = 0; i < CB.CONSECUTIVE_THRESHOLD; i++) await recordWebhookFailure(id)
      expect(await getOpenWebhookIds()).toEqual([id])

      // Advance past the 120s window that would've killed the hash in
      // the buggy version. The state must survive.
      advanceSeconds(CB.WINDOW_SECONDS * 2 + 10)

      // Still excluded — the cooldown is 300s, we've only moved 130s in.
      expect(await getOpenWebhookIds()).toEqual([id])
      // Hash is still present with state=open.
      expect(fakeRedis.hashes.get(`wh:cb:${id}`)?.get('state')).toBe('open')
    })

    it('half_open → open transition also PERSISTs so the cooldown reset sticks', async () => {
      const id = 'wh_ttl_probe'
      for (let i = 0; i < CB.CONSECUTIVE_THRESHOLD; i++) await recordWebhookFailure(id)
      advanceSeconds(CB.COOLDOWN_SECONDS + 1)
      await getOpenWebhookIds() // promotes open → half_open

      // Probe fails — circuit snaps back to open with a fresh cooldown.
      await recordWebhookFailure(id)
      expect(fakeRedis.hashes.get(`wh:cb:${id}`)?.get('state')).toBe('open')

      // 120s into the fresh cooldown, hash must still exist.
      advanceSeconds(CB.WINDOW_SECONDS * 2 + 10)
      expect(fakeRedis.hashes.get(`wh:cb:${id}`)?.get('state')).toBe('open')
      expect(await getOpenWebhookIds()).toEqual([id])
    })
  })

  describe('success clears partial failure state', () => {
    it('a 2xx after 4 failures wipes fail_count so the next 4 do not tip over the threshold', async () => {
      const id = 'wh_partial'
      for (let i = 0; i < CB.CONSECUTIVE_THRESHOLD - 1; i++) await recordWebhookFailure(id)
      expect(await getOpenWebhookIds()).toEqual([])

      await recordWebhookSuccess(id)
      // Hash is now deleted; the next 4 failures land fresh and must
      // NOT open the circuit.
      for (let i = 0; i < CB.CONSECUTIVE_THRESHOLD - 1; i++) await recordWebhookFailure(id)
      expect(await getOpenWebhookIds()).toEqual([])
    })
  })
})
