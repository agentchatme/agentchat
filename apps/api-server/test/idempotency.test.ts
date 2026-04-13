import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'

// Simple in-memory fake Redis that implements just enough of the
// Upstash client surface for the idempotency middleware. Keeps the
// tests hermetic — no network, no Upstash credentials required in CI.
class FakeRedis {
  private store = new Map<string, { value: unknown; expiresAt: number }>()
  // Tests flip this to simulate a flaky Upstash call — the next set/get/del
  // rejects with an error, and the flag auto-clears.
  failNextCall = false

  private maybeFail() {
    if (this.failNextCall) {
      this.failNextCall = false
      throw new Error('redis unavailable')
    }
  }

  async set(
    key: string,
    value: unknown,
    opts?: { nx?: boolean; ex?: number },
  ): Promise<'OK' | null> {
    this.maybeFail()
    const now = Date.now()
    const existing = this.store.get(key)
    if (existing && existing.expiresAt > now) {
      if (opts?.nx) return null
    } else if (existing) {
      this.store.delete(key)
    }
    const ttlMs = opts?.ex ? opts.ex * 1000 : 30 * 60 * 1000
    this.store.set(key, { value, expiresAt: now + ttlMs })
    return 'OK'
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    this.maybeFail()
    const entry = this.store.get(key)
    if (!entry) return null
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key)
      return null
    }
    return entry.value as T
  }

  async del(key: string): Promise<number> {
    this.maybeFail()
    return this.store.delete(key) ? 1 : 0
  }

  clear() {
    this.store.clear()
    this.failNextCall = false
  }
}

const fakeRedis = new FakeRedis()

// Mock getRedis() before importing the middleware so the middleware
// captures the fake at import time.
vi.mock('../src/lib/redis.js', () => ({
  getRedis: () => fakeRedis,
}))

const { idempotencyMiddleware } = await import('../src/middleware/idempotency.js')

// Minimal fake auth middleware — the real one needs a Supabase query,
// which is out of scope here. All we need is c.set('agentId', ...).
const fakeAuth = (agentId: string) =>
  createMiddleware(async (c, next) => {
    c.set('agentId', agentId)
    return next()
  })

// Builds a fresh Hono app with fakeAuth + idempotency in front of a
// test handler that increments a counter and echoes the request body.
function buildApp(agentId: string) {
  let handlerCalls = 0
  const app = new Hono()
  app.post(
    '/test',
    fakeAuth(agentId),
    idempotencyMiddleware,
    async (c) => {
      handlerCalls += 1
      const body = await c.req.json().catch(() => ({}))
      return c.json({ ok: true, handlerCalls, echo: body })
    },
  )
  app.post(
    '/boom',
    fakeAuth(agentId),
    idempotencyMiddleware,
    async (c) => {
      handlerCalls += 1
      return c.json({ code: 'INTERNAL_ERROR', message: 'boom' }, 500)
    },
  )
  return { app, getCalls: () => handlerCalls }
}

function req(path: string, init: RequestInit & { body?: unknown }) {
  const body = init.body === undefined ? undefined : JSON.stringify(init.body)
  return new Request(`http://test.local${path}`, {
    method: init.method ?? 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    body,
  })
}

describe('idempotency middleware', () => {
  beforeEach(() => {
    fakeRedis.clear()
  })

  it('passes through when no Idempotency-Key header is sent', async () => {
    const { app, getCalls } = buildApp('agt_alice')
    const r1 = await app.fetch(req('/test', { body: { x: 1 } }))
    const r2 = await app.fetch(req('/test', { body: { x: 1 } }))
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    expect(getCalls()).toBe(2)
  })

  it('replays a matching repeat and skips the handler', async () => {
    const { app, getCalls } = buildApp('agt_alice')
    const headers = { 'Idempotency-Key': 'test-key-abcdef123' }
    const r1 = await app.fetch(req('/test', { body: { x: 1 }, headers }))
    const r2 = await app.fetch(req('/test', { body: { x: 1 }, headers }))
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    expect(getCalls()).toBe(1)
    expect(r2.headers.get('Idempotent-Replay')).toBe('true')
    const j1 = await r1.json()
    const j2 = await r2.json()
    expect(j1).toEqual(j2)
  })

  it('returns 422 when the same key is reused with a different body', async () => {
    const { app, getCalls } = buildApp('agt_alice')
    const headers = { 'Idempotency-Key': 'test-key-abcdef123' }
    const r1 = await app.fetch(req('/test', { body: { x: 1 }, headers }))
    expect(r1.status).toBe(200)
    const r2 = await app.fetch(req('/test', { body: { x: 2 }, headers }))
    expect(r2.status).toBe(422)
    const err = await r2.json()
    expect(err.code).toBe('IDEMPOTENCY_KEY_CONFLICT')
    expect(getCalls()).toBe(1)
  })

  it('scopes keys per agent — same key from a different agent is independent', async () => {
    const alice = buildApp('agt_alice')
    const bob = buildApp('agt_bob')
    const headers = { 'Idempotency-Key': 'shared-key-abcdef12' }
    const a = await alice.app.fetch(req('/test', { body: { x: 1 }, headers }))
    const b = await bob.app.fetch(req('/test', { body: { x: 2 }, headers }))
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(alice.getCalls()).toBe(1)
    expect(bob.getCalls()).toBe(1)
  })

  it('rejects malformed Idempotency-Key values with 400', async () => {
    const { app, getCalls } = buildApp('agt_alice')
    // 'short' is 5 chars — below the 8-char minimum in KEY_REGEX.
    const r = await app.fetch(
      req('/test', { body: {}, headers: { 'Idempotency-Key': 'short' } }),
    )
    expect(r.status).toBe(400)
    const err = await r.json()
    expect(err.code).toBe('IDEMPOTENCY_KEY_INVALID')
    expect(getCalls()).toBe(0)
    // And a key containing an invalid character also rejected.
    const r2 = await app.fetch(
      req('/test', { body: {}, headers: { 'Idempotency-Key': 'has space here xy' } }),
    )
    expect(r2.status).toBe(400)
    expect(getCalls()).toBe(0)
  })

  it('does not cache 5xx responses — retries are allowed', async () => {
    const { app, getCalls } = buildApp('agt_alice')
    const headers = { 'Idempotency-Key': 'test-key-abcdef123' }
    const r1 = await app.fetch(req('/boom', { body: {}, headers }))
    const r2 = await app.fetch(req('/boom', { body: {}, headers }))
    expect(r1.status).toBe(500)
    expect(r2.status).toBe(500)
    // Both calls reached the handler — the first 500 did NOT get cached.
    expect(getCalls()).toBe(2)
  })

  it('skips GET requests entirely', async () => {
    const app = new Hono()
    let calls = 0
    app.get('/q', fakeAuth('agt_alice'), idempotencyMiddleware, (c) => {
      calls += 1
      return c.json({ ok: true, calls })
    })
    const r1 = await app.fetch(
      new Request('http://test.local/q', {
        method: 'GET',
        headers: { 'Idempotency-Key': 'ignored-key-1234' },
      }),
    )
    const r2 = await app.fetch(
      new Request('http://test.local/q', {
        method: 'GET',
        headers: { 'Idempotency-Key': 'ignored-key-1234' },
      }),
    )
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    expect(calls).toBe(2)
  })

  it('fail-opens when Redis throws on claim', async () => {
    const { app, getCalls } = buildApp('agt_alice')
    fakeRedis.failNextCall = true
    const headers = { 'Idempotency-Key': 'test-key-abcdef123' }
    const r = await app.fetch(req('/test', { body: { x: 1 }, headers }))
    expect(r.status).toBe(200)
    expect(getCalls()).toBe(1)
  })

  it('replays status and body verbatim', async () => {
    const app = new Hono()
    app.post(
      '/created',
      fakeAuth('agt_alice'),
      idempotencyMiddleware,
      (c) => c.json({ created: true, id: 'obj_1' }, 201),
    )
    const headers = { 'Idempotency-Key': 'test-key-abcdef123' }
    const r1 = await app.fetch(req('/created', { body: {}, headers }))
    const r2 = await app.fetch(req('/created', { body: {}, headers }))
    expect(r1.status).toBe(201)
    expect(r2.status).toBe(201)
    expect(await r1.json()).toEqual({ created: true, id: 'obj_1' })
    expect(await r2.json()).toEqual({ created: true, id: 'obj_1' })
    expect(r2.headers.get('Idempotent-Replay')).toBe('true')
  })
})
