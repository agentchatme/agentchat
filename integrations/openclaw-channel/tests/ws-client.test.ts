/**
 * Unit tests for the AgentChat WS client.
 *
 * Strategy: we mock the `ws` package's `WebSocket` with a hand-rolled
 * `MockWebSocket` that exposes `open()/message()/close()/pong()` control
 * methods the test drives. We also substitute the timer functions so
 * reconnect backoff and heartbeat behavior is deterministic and fast.
 *
 * What we cover:
 *   - Happy path: open → HELLO → hello.ok → READY, inbound frame delivery
 *   - Auth failure: hello.error → AUTH_FAIL + terminal error emitted
 *   - Reconnect: close → exponential backoff → second attempt
 *   - Heartbeat: ping at interval, pong clears timer, miss → PING_TIMEOUT
 *   - Graceful drain: stop(deadline) moves to DRAINING, then CLOSED
 *   - Hard cap: reconnect loop surfaces AUTH_FAIL after N attempts
 *   - Malformed inbound → validation error, connection stays up
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { AgentchatWsClient } from '../src/ws-client.js'
import { parseChannelConfig, type AgentchatChannelConfig } from '../src/config-schema.js'
import type { Logger } from '../src/log.js'
import { createNoopMetrics } from '../src/metrics.js'

const VALID_KEY = 'ac_live_' + 'x'.repeat(20)

function makeConfig(overrides: Record<string, unknown> = {}): AgentchatChannelConfig {
  return parseChannelConfig({
    apiKey: VALID_KEY,
    apiBase: 'https://api.agentchat.me',
    ...overrides,
  })
}

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

// ─── Mock WebSocket ────────────────────────────────────────────────────
//
// Implements the subset of `ws.WebSocket` our client actually uses:
// constructor(url, opts), readyState, on('open'|'message'|'pong'|'close'|'error'),
// send(str), ping(), close(code, reason).

const mockInstances: MockWebSocket[] = []

class MockWebSocket extends EventEmitter {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  readyState = MockWebSocket.CONNECTING
  sent: string[] = []
  pinged = 0
  closedWith: { code: number; reason: string } | null = null
  url: string
  constructor(url: string, _opts?: unknown) {
    super()
    this.url = url
    mockInstances.push(this)
  }
  send(data: string): void {
    if (this.readyState !== MockWebSocket.OPEN) {
      // simulate write-after-close
      throw new Error('send on closed socket')
    }
    this.sent.push(data)
  }
  ping(): void {
    this.pinged += 1
  }
  close(code = 1000, reason = ''): void {
    if (this.readyState === MockWebSocket.CLOSED) return
    this.readyState = MockWebSocket.CLOSED
    this.closedWith = { code, reason }
    // 'close' fires asynchronously like the real thing, but we call it
    // synchronously in tests so assertions can run without awaiting.
    this.emit('close', code, Buffer.from(reason))
  }
  // Test helpers
  doOpen(): void {
    this.readyState = MockWebSocket.OPEN
    this.emit('open')
  }
  doMessage(payload: unknown, isBinary = false): void {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload)
    this.emit('message', Buffer.from(data), isBinary)
  }
  doPong(): void {
    this.emit('pong')
  }
  doError(err: Error): void {
    this.emit('error', err)
  }
}

// ─── Fake timers ───────────────────────────────────────────────────────

interface ScheduledTimeout {
  id: number
  fireAt: number
  fn: () => void
  kind: 'timeout' | 'interval'
  intervalMs?: number
}

class TimerHarness {
  now = 0
  private next = 1
  private pending: ScheduledTimeout[] = []
  setTimeout = (fn: () => void, ms: number): NodeJS.Timeout => {
    const t: ScheduledTimeout = {
      id: this.next++,
      fireAt: this.now + ms,
      fn,
      kind: 'timeout',
    }
    this.pending.push(t)
    return t.id as unknown as NodeJS.Timeout
  }
  clearTimeout = (h: NodeJS.Timeout): void => {
    this.pending = this.pending.filter((t) => (t.id as unknown as NodeJS.Timeout) !== h)
  }
  setInterval = (fn: () => void, ms: number): NodeJS.Timeout => {
    const t: ScheduledTimeout = {
      id: this.next++,
      fireAt: this.now + ms,
      fn,
      kind: 'interval',
      intervalMs: ms,
    }
    this.pending.push(t)
    return t.id as unknown as NodeJS.Timeout
  }
  clearInterval = (h: NodeJS.Timeout): void => {
    this.clearTimeout(h)
  }
  advance(ms: number): void {
    const target = this.now + ms
    // Process events in fire-time order until we reach target.
    while (true) {
      this.pending.sort((a, b) => a.fireAt - b.fireAt)
      const next = this.pending[0]
      if (!next || next.fireAt > target) break
      this.now = next.fireAt
      this.pending.shift()
      next.fn()
      if (next.kind === 'interval' && next.intervalMs) {
        this.pending.push({ ...next, fireAt: this.now + next.intervalMs })
      }
    }
    this.now = target
  }
}

beforeEach(() => {
  mockInstances.length = 0
})

afterEach(() => {
  mockInstances.length = 0
})

function makeClient(cfg?: Partial<Record<string, unknown>>) {
  const timers = new TimerHarness()
  const client = new AgentchatWsClient({
    config: makeConfig(cfg),
    logger: silentLogger(),
    metrics: createNoopMetrics(),
    now: () => timers.now,
    webSocketCtor: MockWebSocket as unknown as typeof import('ws').WebSocket,
    random: () => 0.5,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  })
  return { client, timers }
}

describe('AgentchatWsClient — happy path', () => {
  it('transitions DISCONNECTED → CONNECTING → AUTHENTICATING → READY and emits authenticated', () => {
    const { client } = makeClient()
    const states: string[] = []
    const auths: number[] = []
    client.on('stateChanged', (next) => states.push(next.kind))
    client.on('authenticated', (at) => auths.push(at))

    expect(client.getState().kind).toBe('DISCONNECTED')
    client.start()
    expect(client.getState().kind).toBe('CONNECTING')
    expect(mockInstances.length).toBe(1)

    const sock = mockInstances[0]!
    sock.doOpen()
    expect(client.getState().kind).toBe('AUTHENTICATING')
    // HELLO was sent on open
    expect(sock.sent).toHaveLength(1)
    expect(JSON.parse(sock.sent[0]!)).toEqual({
      type: 'hello',
      api_key: VALID_KEY,
    })

    sock.doMessage({ type: 'hello.ok', payload: {} })
    expect(client.getState().kind).toBe('READY')
    expect(states).toEqual(['CONNECTING', 'AUTHENTICATING', 'READY'])
    expect(auths).toHaveLength(1)
  })

  it('delivers inbound frames to subscribers after HELLO_OK', () => {
    const { client } = makeClient()
    const frames: unknown[] = []
    client.on('inboundFrame', (f) => frames.push(f))
    client.start()
    const sock = mockInstances[0]!
    sock.doOpen()
    sock.doMessage({ type: 'hello.ok', payload: {} })

    sock.doMessage({
      type: 'message.new',
      payload: { id: 'msg_1', seq: 1, content: { text: 'hi' } },
    })

    expect(frames).toHaveLength(1)
    const frame = frames[0] as { type: string; payload: Record<string, unknown> }
    expect(frame.type).toBe('message.new')
    expect(frame.payload.id).toBe('msg_1')
  })

  it('does not deliver pre-hello frames to subscribers', () => {
    const { client } = makeClient()
    const frames: unknown[] = []
    client.on('inboundFrame', (f) => frames.push(f))
    client.start()
    const sock = mockInstances[0]!
    sock.doOpen()
    // A server-sent event that arrives before hello.ok should be dropped.
    sock.doMessage({ type: 'message.new', payload: { id: 'surprise' } })
    expect(frames).toHaveLength(0)
  })

  it('send() returns true in READY and pushes stringified frame', () => {
    const { client } = makeClient()
    client.start()
    const sock = mockInstances[0]!
    sock.doOpen()
    sock.doMessage({ type: 'hello.ok', payload: {} })
    const ok = client.send({ type: 'typing.start', payload: { conversation_id: 'dir_x' } })
    expect(ok).toBe(true)
    // First send is HELLO; second is the actual frame.
    expect(sock.sent).toHaveLength(2)
    expect(JSON.parse(sock.sent[1]!)).toEqual({
      type: 'typing.start',
      payload: { conversation_id: 'dir_x' },
    })
  })

  it('send() returns false when not READY', () => {
    const { client } = makeClient()
    client.start()
    const ok = client.send({ type: 'typing.start', payload: {} })
    expect(ok).toBe(false)
  })
})

describe('AgentchatWsClient — auth failure', () => {
  it('moves to AUTH_FAIL on hello.error and emits terminal-auth', () => {
    const { client } = makeClient()
    const errors: { class_: string; message: string }[] = []
    client.on('error', (e) => errors.push({ class_: e.class_, message: e.message }))
    client.start()
    const sock = mockInstances[0]!
    sock.doOpen()
    sock.doMessage({
      type: 'hello.error',
      payload: { message: 'invalid api key' },
    })
    expect(client.getState().kind).toBe('AUTH_FAIL')
    expect(errors.some((e) => e.class_ === 'terminal-auth')).toBe(true)
  })

  it('close code 1008 during authenticating moves to AUTH_FAIL', () => {
    const { client } = makeClient()
    client.start()
    const sock = mockInstances[0]!
    sock.doOpen()
    sock.close(1008, 'auth rejected')
    expect(client.getState().kind).toBe('AUTH_FAIL')
  })

  it('reconfigured() clears AUTH_FAIL back to DISCONNECTED', () => {
    const { client } = makeClient()
    client.start()
    const sock = mockInstances[0]!
    sock.doOpen()
    sock.close(1008, 'auth rejected')
    expect(client.getState().kind).toBe('AUTH_FAIL')
    client.reconfigured()
    expect(client.getState().kind).toBe('DISCONNECTED')
  })

  it('start() throws when in AUTH_FAIL without reconfigured', () => {
    const { client } = makeClient()
    client.start()
    const sock = mockInstances[0]!
    sock.doOpen()
    sock.close(1008, 'auth rejected')
    expect(() => client.start()).toThrow(/AUTH_FAIL/)
  })
})

describe('AgentchatWsClient — reconnect', () => {
  it('schedules reconnect on unexpected close and connects again', () => {
    const { client, timers } = makeClient()
    client.start()
    const sock1 = mockInstances[0]!
    sock1.doOpen()
    sock1.doMessage({ type: 'hello.ok', payload: {} })
    expect(client.getState().kind).toBe('READY')

    // Simulate server-initiated close
    sock1.close(1006, 'abnormal')
    expect(client.getState().kind).toBe('DISCONNECTED')

    // initialBackoffMs default 1000, with random=0.5 and jitterRatio 0.2 →
    // 1 * (1 - 0.2 + 0.5 * 0.4) = 1.0 of initial = 1000ms
    timers.advance(1000)
    expect(mockInstances.length).toBe(2)
    expect(client.getState().kind).toBe('CONNECTING')
  })

  it('applies exponential backoff: attempt 2 waits ~2000ms', () => {
    const { client, timers } = makeClient({
      reconnect: { initialBackoffMs: 1000, maxBackoffMs: 30000, jitterRatio: 0 },
    })
    client.start()
    mockInstances[0]!.close(1006, 'abnormal')
    // First backoff (attempt 1): 1000 * 2^0 = 1000
    timers.advance(1000)
    expect(mockInstances.length).toBe(2)
    mockInstances[1]!.close(1006, 'abnormal')
    // Second backoff (attempt 2): 1000 * 2^1 = 2000
    timers.advance(1999)
    expect(mockInstances.length).toBe(2) // not yet
    timers.advance(1)
    expect(mockInstances.length).toBe(3)
  })

  it('caps backoff at maxBackoffMs', () => {
    const { client, timers } = makeClient({
      reconnect: { initialBackoffMs: 1000, maxBackoffMs: 5000, jitterRatio: 0 },
    })
    client.start()
    // Drop through enough attempts to saturate — attempt 10 without cap
    // would be 512000ms; cap pins it at 5000.
    for (let i = 0; i < 10; i++) {
      mockInstances[mockInstances.length - 1]!.close(1006, 'abnormal')
      timers.advance(5000)
    }
    expect(mockInstances.length).toBeGreaterThan(5)
  })
})

describe('AgentchatWsClient — heartbeat', () => {
  it('sends ping at interval and clears pong timer on pong', () => {
    const { client, timers } = makeClient({ ping: { intervalMs: 5000, timeoutMs: 2000 } })
    client.start()
    const sock = mockInstances[0]!
    sock.doOpen()
    sock.doMessage({ type: 'hello.ok', payload: {} })
    expect(sock.pinged).toBe(0)
    timers.advance(5000)
    expect(sock.pinged).toBe(1)
    sock.doPong()
    // pong cleared the timer — no timeout fires
    timers.advance(5000)
    expect(sock.pinged).toBe(2)
    expect(client.getState().kind).toBe('READY')
  })

  it('force-closes on ping timeout and reconnects', () => {
    const { client, timers } = makeClient({ ping: { intervalMs: 5000, timeoutMs: 2000 } })
    client.start()
    const sock = mockInstances[0]!
    sock.doOpen()
    sock.doMessage({ type: 'hello.ok', payload: {} })
    timers.advance(5000)
    expect(sock.pinged).toBe(1)
    // No pong — after timeoutMs we transition DEGRADED + close.
    timers.advance(2000)
    // Close code 1011 (our signal for ping timeout), then reconnect is scheduled.
    expect(client.getState().kind).toBe('DISCONNECTED')
    expect(sock.closedWith?.code).toBe(1011)
  })
})

describe('AgentchatWsClient — drain', () => {
  it('stop() in READY moves to DRAINING, then CLOSED on drainCompleted', () => {
    const { client } = makeClient()
    const events: string[] = []
    client.on('stateChanged', (s) => events.push(s.kind))
    client.start()
    const sock = mockInstances[0]!
    sock.doOpen()
    sock.doMessage({ type: 'hello.ok', payload: {} })

    client.stop(Date.now() + 10_000)
    expect(client.getState().kind).toBe('DRAINING')
    client.drainCompleted()
    expect(client.getState().kind).toBe('CLOSED')
    expect(events).toContain('DRAINING')
    expect(events).toContain('CLOSED')
  })

  it('stop() in DISCONNECTED moves directly to CLOSED', () => {
    const { client } = makeClient()
    client.stop()
    expect(client.getState().kind).toBe('CLOSED')
  })

  it('drain deadline forces close', () => {
    const { client, timers } = makeClient()
    client.start()
    const sock = mockInstances[0]!
    sock.doOpen()
    sock.doMessage({ type: 'hello.ok', payload: {} })

    client.stop(timers.now + 1000)
    expect(client.getState().kind).toBe('DRAINING')
    timers.advance(1000)
    expect(client.getState().kind).toBe('CLOSED')
    expect(sock.closedWith?.code).toBe(1000)
  })
})

describe('AgentchatWsClient — malformed inbound', () => {
  it('emits validation error on non-JSON frame but stays connected', () => {
    const { client } = makeClient()
    const errors: string[] = []
    client.on('error', (e) => errors.push(e.class_))
    client.start()
    const sock = mockInstances[0]!
    sock.doOpen()
    sock.doMessage({ type: 'hello.ok', payload: {} })
    sock.doMessage('not-json-at-all')
    expect(errors).toContain('validation')
    expect(client.getState().kind).toBe('READY')
  })

  it('drops frame missing type field', () => {
    const { client } = makeClient()
    const frames: unknown[] = []
    const errors: string[] = []
    client.on('inboundFrame', (f) => frames.push(f))
    client.on('error', (e) => errors.push(e.class_))
    client.start()
    const sock = mockInstances[0]!
    sock.doOpen()
    sock.doMessage({ type: 'hello.ok', payload: {} })
    sock.doMessage({ payload: { foo: 'bar' } })
    expect(frames).toHaveLength(0)
    expect(errors).toContain('validation')
  })
})

describe('AgentchatWsClient — reconnect hard cap', () => {
  it('surfaces AUTH_FAIL after RECONNECT_HARD_CAP_ATTEMPTS exceeded', () => {
    const { client, timers } = makeClient({
      reconnect: { initialBackoffMs: 100, maxBackoffMs: 1000, jitterRatio: 0 },
    })
    client.start()
    // Loop closing immediately; we need 60 successful attempt-transitions
    // before the hard cap bites. Each attempt: open → send close.
    for (let i = 0; i < 65; i++) {
      const sock = mockInstances[mockInstances.length - 1]
      if (!sock) break
      // Force-close before HELLO_OK so each counts as a reconnect.
      if (sock.readyState !== MockWebSocket.CLOSED) {
        sock.close(1006, 'flap')
      }
      // Advance enough for any scheduled backoff (max 1000ms with no jitter).
      timers.advance(1000)
      if (client.getState().kind === 'AUTH_FAIL') break
    }
    expect(client.getState().kind).toBe('AUTH_FAIL')
  })
})
