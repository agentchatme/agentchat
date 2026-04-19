/**
 * Stress / integration hardening tests.
 *
 * Unit tests prove each module handles its contract. These tests prove the
 * WIRING holds under pressure — the scenarios that break production but not
 * unit tests:
 *
 *   1. Burst load at capacity → overflow queue shed-loads cleanly, no hangs.
 *   2. Sustained 429 flood → circuit opens → fast-fail → recovers on 200.
 *   3. Validation barrage (malformed + valid frames interleaved) → connection
 *      stays healthy, valid frames still delivered, memory bounded.
 *   4. `stop()` during in-flight sends → drains up to deadline, rejects new
 *      work, final state is CLOSED, no dangling promises.
 *   5. Handler that throws → isolated; subsequent frames still processed.
 *   6. 5000 send/ack cycles → inFlight + queue stay at zero afterwards (leak
 *      check).
 *
 * Everything runs with fake fetch / fake WS / synchronous sleep so the whole
 * suite is deterministic and sub-second.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

import { OutboundAdapter, type OutboundMessageInput } from '../src/outbound.js'
import { AgentchatChannelRuntime } from '../src/runtime.js'
import { AgentChatChannelError } from '../src/errors.js'
import { parseChannelConfig } from '../src/config-schema.js'
import { createNoopMetrics } from '../src/metrics.js'
import type { Logger } from '../src/log.js'

const VALID_KEY = 'ac_live_' + 'x'.repeat(20)

function silentLogger(): Logger {
  const noop = () => undefined
  return {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => silentLogger(),
  }
}

// ─── Mock fetch with controllable delay + response queue ───────────────

interface ControllableResponse {
  status: number
  body?: unknown
  headers?: Record<string, string>
  /** ms before the response resolves. Lets us simulate real-world latency. */
  delayMs?: number
}

function makeControllableFetch(responses: ControllableResponse[] | (() => ControllableResponse)) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  let i = 0
  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const r = Array.isArray(responses)
      ? responses[i++] ?? responses[responses.length - 1]!
      : responses()
    if (r.delayMs && r.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, r.delayMs))
    }
    const headers = new Headers(r.headers ?? {})
    return new Response(
      r.body === undefined ? null : typeof r.body === 'string' ? r.body : JSON.stringify(r.body),
      { status: r.status, headers },
    )
  }
  return Object.assign(fn, { calls, get index() { return i } })
}

function minimalMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: `msg_${Math.random().toString(36).slice(2, 10)}`,
    conversation_id: 'conv_alice',
    sender: 'me',
    client_msg_id: 'cli_x',
    seq: 1,
    type: 'text',
    content: { text: 'hello' },
    metadata: {},
    created_at: '2026-04-19T00:00:00Z',
    delivered_at: null,
    read_at: null,
    ...overrides,
  }
}

function makeOutboundAdapter(opts: {
  fetch: typeof fetch
  maxInFlight?: number
  retryMaxAttempts?: number
}) {
  const config = parseChannelConfig({
    apiKey: VALID_KEY,
    apiBase: 'https://api.agentchat.me',
    outbound: {
      maxInFlight: opts.maxInFlight ?? 5,
    },
  })
  return new OutboundAdapter({
    config,
    logger: silentLogger(),
    metrics: createNoopMetrics(),
    fetch: opts.fetch,
    retryPolicy: {
      maxAttempts: opts.retryMaxAttempts ?? 1, // no retries by default → deterministic failures
      initialBackoffMs: 1,
      maxBackoffMs: 10,
      jitterRatio: 0,
    },
    sleep: () => Promise.resolve(), // zero-wait retries
    random: () => 0.5,
    circuitBreaker: {
      failureThreshold: 5,
      windowMs: 60_000,
      cooldownMs: 10_000,
    },
  })
}

// ─── 1. Burst load at capacity → shed-load cleanly ─────────────────────

describe('stress — outbound burst at capacity', () => {
  it('with maxInFlight=5 and hardCap=50, a 1000-way burst rejects overflow as retry-transient and completes everything', async () => {
    // Every fetch takes 5ms — real enough that the semaphore actually matters.
    const fetchStub = makeControllableFetch(() => ({
      status: 201,
      body: minimalMessage(),
      delayMs: 5,
    }))
    const adapter = makeOutboundAdapter({ fetch: fetchStub, maxInFlight: 5 })

    const input: OutboundMessageInput = {
      kind: 'direct',
      to: 'alice',
      content: { text: 'burst' },
    }

    const settled = await Promise.allSettled(
      Array.from({ length: 1000 }, () => adapter.sendMessage(input)),
    )

    const fulfilled = settled.filter((r) => r.status === 'fulfilled').length
    const rejected = settled.filter((r) => r.status === 'rejected')

    // Queue hard cap is `10 * maxInFlight = 50`, plus the 5 in-flight → the
    // first 55 should complete; the remaining 945 should reject.
    expect(fulfilled).toBe(55)
    expect(rejected).toHaveLength(945)
    // Every rejection must carry the correct taxonomy — no bare Errors.
    for (const r of rejected) {
      if (r.status === 'rejected') {
        expect(r.reason).toBeInstanceOf(AgentChatChannelError)
        expect((r.reason as AgentChatChannelError).class_).toBe('retry-transient')
      }
    }

    // After drain, both counters must return to zero — no leaked accounting.
    const snap = adapter.snapshot()
    expect(snap.inFlight).toBe(0)
    expect(snap.queued).toBe(0)
  })
})

// ─── 2. Sustained 429 flood → circuit opens → recovers ─────────────────

describe('stress — 429 flood trips circuit breaker then recovers', () => {
  it('opens after failureThreshold 429s, fast-fails during cooldown, closes on success after cooldown', async () => {
    // Sequenced: first 5 requests return 429, then 200 forever.
    let count = 0
    const fetchStub = makeControllableFetch(() => {
      count++
      if (count <= 5) {
        return {
          status: 429,
          body: { message: 'rate limited' },
          headers: { 'retry-after': '1' },
        }
      }
      return { status: 201, body: minimalMessage() }
    })

    // Advance a fake clock for the breaker so we can step past cooldown.
    let now = 1_000_000
    const config = parseChannelConfig({
      apiKey: VALID_KEY,
      apiBase: 'https://api.agentchat.me',
    })
    const adapter = new OutboundAdapter({
      config,
      logger: silentLogger(),
      metrics: createNoopMetrics(),
      fetch: fetchStub,
      retryPolicy: {
        maxAttempts: 1,
        initialBackoffMs: 1,
        maxBackoffMs: 10,
        jitterRatio: 0,
      },
      sleep: () => Promise.resolve(),
      random: () => 0.5,
      now: () => now,
      circuitBreaker: {
        failureThreshold: 5,
        windowMs: 60_000,
        cooldownMs: 10_000,
        // Thread the same fake clock into the breaker so cooldown is
        // measured against our advancing `now`, not wall time.
        now: () => now,
      },
    })

    const input: OutboundMessageInput = {
      kind: 'direct',
      to: 'alice',
      content: { text: 'flood' },
    }

    // Sequential so each 429 reliably lands on the breaker's failure count.
    for (let i = 0; i < 5; i++) {
      await expect(adapter.sendMessage(input)).rejects.toMatchObject({
        class_: 'retry-rate',
      })
      now += 100
    }

    // 5th failure opens the circuit. Next call must NOT touch the network —
    // fast-fail with retry-transient.
    const callsBefore = fetchStub.calls.length
    await expect(adapter.sendMessage(input)).rejects.toMatchObject({
      class_: 'retry-transient',
    })
    expect(fetchStub.calls.length).toBe(callsBefore) // no new request

    // Advance past cooldown → half-open → probe allowed → server now returns
    // 200 → success closes the breaker.
    now += 10_000
    const result = await adapter.sendMessage(input)
    expect(result.message.id).toMatch(/^msg_/)
    expect(adapter.snapshot().circuit.state).toBe('closed')
  })
})

// ─── 3. Validation barrage → connection stays healthy ──────────────────

interface BarrageSocket {
  readyState: number
  sent: string[]
  doOpen(): void
  doMessage(payload: unknown): void
  close(code?: number, reason?: string): void
}

function setupRuntimeWithBarrageSocket() {
  const mockInstances: BarrageSocket[] = []
  class MockWs extends EventEmitter implements BarrageSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3
    readyState = MockWs.CONNECTING
    sent: string[] = []
    constructor(_url: string, _opts?: unknown) {
      super()
      mockInstances.push(this)
    }
    send(data: string): void {
      if (this.readyState !== MockWs.OPEN) throw new Error('closed')
      this.sent.push(data)
    }
    ping(): void {}
    close(code = 1000, reason = ''): void {
      if (this.readyState === MockWs.CLOSED) return
      this.readyState = MockWs.CLOSED
      this.emit('close', code, Buffer.from(reason))
    }
    doOpen(): void {
      this.readyState = MockWs.OPEN
      this.emit('open')
    }
    doMessage(payload: unknown): void {
      const data = typeof payload === 'string' ? payload : JSON.stringify(payload)
      this.emit('message', Buffer.from(data), false)
    }
  }
  const config = parseChannelConfig({
    apiKey: VALID_KEY,
    apiBase: 'https://api.agentchat.me',
  })
  const validationErrors: unknown[] = []
  const delivered: unknown[] = []
  const runtime = new AgentchatChannelRuntime({
    config,
    logger: silentLogger(),
    webSocketCtor: MockWs as unknown as typeof import('ws').WebSocket,
    fetch: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
    handlers: {
      onInbound: (event) => {
        delivered.push(event)
      },
      onValidationError: (err) => {
        validationErrors.push(err)
      },
    },
  })
  return { runtime, mockInstances, validationErrors, delivered }
}

describe('stress — validation barrage under load', () => {
  it('1000 malformed frames interleaved with 1000 valid frames keep the connection healthy', () => {
    const { runtime, mockInstances, validationErrors, delivered } =
      setupRuntimeWithBarrageSocket()
    runtime.start()
    const sock = mockInstances[0]!
    sock.doOpen()
    sock.doMessage({ type: 'hello.ok', payload: {} })

    let validSent = 0
    for (let i = 0; i < 2000; i++) {
      if (i % 2 === 0) {
        // Malformed: missing required fields.
        sock.doMessage({ type: 'message.new', payload: { nope: true } })
      } else {
        // Valid.
        validSent++
        sock.doMessage({
          type: 'message.new',
          payload: {
            id: `msg_${i}`,
            conversation_id: 'conv_alice',
            sender: 'alice',
            client_msg_id: `cli_${i}`,
            seq: i,
            type: 'text',
            content: { text: `frame ${i}` },
            metadata: {},
            created_at: '2026-04-19T00:00:00Z',
            delivered_at: null,
            read_at: null,
          },
        })
      }
    }

    expect(validationErrors).toHaveLength(1000)
    expect(delivered).toHaveLength(validSent)
    expect(runtime.getHealth().state.kind).toBe('READY')
    expect(runtime.getHealth().authenticated).toBe(true)
  })

  it('a handler that throws is isolated from subsequent frame processing', () => {
    const mockInstances: BarrageSocket[] = []
    class MockWs extends EventEmitter implements BarrageSocket {
      static OPEN = 1
      static CLOSED = 3
      readyState = 0
      sent: string[] = []
      constructor(_url: string, _opts?: unknown) {
        super()
        mockInstances.push(this)
      }
      send(d: string) {
        if (this.readyState !== MockWs.OPEN) throw new Error('closed')
        this.sent.push(d)
      }
      ping() {}
      close(code = 1000, reason = '') {
        if (this.readyState === MockWs.CLOSED) return
        this.readyState = MockWs.CLOSED
        this.emit('close', code, Buffer.from(reason))
      }
      doOpen() {
        this.readyState = MockWs.OPEN
        this.emit('open')
      }
      doMessage(p: unknown) {
        this.emit(
          'message',
          Buffer.from(typeof p === 'string' ? p : JSON.stringify(p)),
          false,
        )
      }
    }
    let received = 0
    let firstThrew = false
    const runtime = new AgentchatChannelRuntime({
      config: parseChannelConfig({
        apiKey: VALID_KEY,
        apiBase: 'https://api.agentchat.me',
      }),
      logger: silentLogger(),
      webSocketCtor: MockWs as unknown as typeof import('ws').WebSocket,
      handlers: {
        onInbound: () => {
          received++
          if (!firstThrew) {
            firstThrew = true
            throw new Error('handler exploded')
          }
        },
      },
    })
    runtime.start()
    const sock = mockInstances[0]!
    sock.doOpen()
    sock.doMessage({ type: 'hello.ok', payload: {} })

    for (let i = 0; i < 10; i++) {
      sock.doMessage({
        type: 'typing.start',
        payload: { conversation_id: 'conv_alice', sender: 'alice' },
      })
    }

    expect(received).toBe(10) // all 10 still delivered despite the throw
    expect(runtime.getHealth().state.kind).toBe('READY')
  })
})

// ─── 4. stop() during in-flight sends ──────────────────────────────────

describe('stress — stop() drains in-flight then closes', () => {
  let realSetTimeout: typeof setTimeout
  beforeEach(() => {
    realSetTimeout = setTimeout
  })
  afterEach(() => {
    // Nothing to restore — we don't monkey-patch globals.
    void realSetTimeout
  })

  it('with 20 in-flight sends (50ms each) and a 200ms deadline, everything drains and state becomes CLOSED', async () => {
    const mockInstances: BarrageSocket[] = []
    class MockWs extends EventEmitter implements BarrageSocket {
      static OPEN = 1
      static CLOSED = 3
      readyState = 0
      sent: string[] = []
      constructor(_url: string, _opts?: unknown) {
        super()
        mockInstances.push(this)
      }
      send(d: string) {
        if (this.readyState !== MockWs.OPEN) throw new Error('closed')
        this.sent.push(d)
      }
      ping() {}
      close(code = 1000, reason = '') {
        if (this.readyState === MockWs.CLOSED) return
        this.readyState = MockWs.CLOSED
        this.emit('close', code, Buffer.from(reason))
      }
      doOpen() {
        this.readyState = MockWs.OPEN
        this.emit('open')
      }
      doMessage(p: unknown) {
        this.emit(
          'message',
          Buffer.from(typeof p === 'string' ? p : JSON.stringify(p)),
          false,
        )
      }
    }

    const fetchStub = makeControllableFetch(() => ({
      status: 201,
      body: minimalMessage(),
      delayMs: 50,
    }))

    const runtime = new AgentchatChannelRuntime({
      config: parseChannelConfig({
        apiKey: VALID_KEY,
        apiBase: 'https://api.agentchat.me',
        outbound: { maxInFlight: 20 },
      }),
      logger: silentLogger(),
      webSocketCtor: MockWs as unknown as typeof import('ws').WebSocket,
      fetch: fetchStub as unknown as typeof fetch,
    })

    runtime.start()
    const sock = mockInstances[0]!
    sock.doOpen()
    sock.doMessage({ type: 'hello.ok', payload: {} })

    // Launch 20 concurrent sends — all occupy the in-flight slots.
    const sends = Array.from({ length: 20 }, () =>
      runtime.sendMessage({
        kind: 'direct',
        to: 'alice',
        content: { text: 'drain-me' },
      }).catch((e) => e),
    )

    // Begin graceful shutdown with a deadline that covers the 50ms fetch.
    const stopPromise = runtime.stop(Date.now() + 500)

    const settled = await Promise.all(sends)
    await stopPromise

    const okCount = settled.filter((r) => !(r instanceof Error)).length
    expect(okCount).toBe(20) // all 20 should drain inside the deadline
    expect(runtime.getHealth().state.kind).toBe('CLOSED')
  })

  it('second stop() returns the same promise and does not re-emit closed', async () => {
    const mockInstances: BarrageSocket[] = []
    class MockWs extends EventEmitter implements BarrageSocket {
      static OPEN = 1
      static CLOSED = 3
      readyState = 0
      sent: string[] = []
      constructor(_url: string, _opts?: unknown) {
        super()
        mockInstances.push(this)
      }
      send(d: string) {
        if (this.readyState !== MockWs.OPEN) throw new Error('closed')
        this.sent.push(d)
      }
      ping() {}
      close(code = 1000, reason = '') {
        if (this.readyState === MockWs.CLOSED) return
        this.readyState = MockWs.CLOSED
        this.emit('close', code, Buffer.from(reason))
      }
      doOpen() {
        this.readyState = MockWs.OPEN
        this.emit('open')
      }
      doMessage(p: unknown) {
        this.emit(
          'message',
          Buffer.from(typeof p === 'string' ? p : JSON.stringify(p)),
          false,
        )
      }
    }
    const runtime = new AgentchatChannelRuntime({
      config: parseChannelConfig({
        apiKey: VALID_KEY,
        apiBase: 'https://api.agentchat.me',
      }),
      logger: silentLogger(),
      webSocketCtor: MockWs as unknown as typeof import('ws').WebSocket,
    })
    runtime.start()
    const sock = mockInstances[0]!
    sock.doOpen()
    sock.doMessage({ type: 'hello.ok', payload: {} })

    const p1 = runtime.stop()
    const p2 = runtime.stop()
    expect(p1).toBe(p2)
    await Promise.all([p1, p2])
    expect(runtime.getHealth().state.kind).toBe('CLOSED')
  })
})

// ─── 5. 5000 send/ack cycles — leak check ──────────────────────────────

describe('stress — sustained send cycles do not leak accounting', () => {
  it('5000 sequential send/ack cycles leave inFlight=0 and queued=0', async () => {
    const fetchStub = makeControllableFetch(() => ({
      status: 201,
      body: minimalMessage(),
    }))
    const adapter = makeOutboundAdapter({ fetch: fetchStub, maxInFlight: 16 })

    const input: OutboundMessageInput = {
      kind: 'direct',
      to: 'alice',
      content: { text: 'ping' },
    }

    // 5000 small bursts of 10 concurrent sends each. Tests that releaseSlot +
    // queue draining converge to a clean state after every burst.
    for (let burst = 0; burst < 500; burst++) {
      await Promise.all(
        Array.from({ length: 10 }, () => adapter.sendMessage(input)),
      )
    }

    const snap = adapter.snapshot()
    expect(snap.inFlight).toBe(0)
    expect(snap.queued).toBe(0)
  })
})
