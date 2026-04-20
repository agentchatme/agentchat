/**
 * Tests for AgentchatChannelRuntime.
 *
 * Strategy: reuse the same MockWebSocket + TimerHarness pattern from
 * `ws-client.test.ts`, plus a stubbed fetch for outbound. We assert:
 *   - handlers are invoked with the right normalized shape
 *   - errors thrown by user handlers never escape (they're logged, not
 *     bubbled — a faulty handler should not crash the channel)
 *   - `sendMessage` delegates to the outbound adapter
 *   - `sendWsAction` routes through the WS client
 *   - `getHealth()` returns a combined snapshot
 *   - `start()` is idempotent
 *   - `stop()` drains outbound before closing the WS
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { AgentchatChannelRuntime, type ChannelRuntimeHandlers } from '../src/runtime.js'
import { parseChannelConfig, type AgentchatChannelConfig } from '../src/config-schema.js'
import type { Logger } from '../src/log.js'

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

// ─── MockWebSocket (same as ws-client.test.ts) ─────────────────────────

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
    this.emit('close', code, Buffer.from(reason))
  }
  doOpen(): void {
    this.readyState = MockWebSocket.OPEN
    this.emit('open')
  }
  doMessage(payload: unknown): void {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload)
    this.emit('message', Buffer.from(data), false)
  }
}

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
    const t: ScheduledTimeout = { id: this.next++, fireAt: this.now + ms, fn, kind: 'timeout' }
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
  clearInterval = (h: NodeJS.Timeout): void => this.clearTimeout(h)
  advance(ms: number): void {
    const target = this.now + ms
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

// ─── Fetch stub (mirrors outbound.test.ts) ─────────────────────────────

interface StubResponse {
  status: number
  body: unknown
  headers?: Record<string, string>
}

function makeFetch(responses: StubResponse[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  let i = 0
  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    if (i >= responses.length) throw new Error('stub exhausted')
    const r = responses[i++]!
    const headers = new Headers(r.headers ?? {})
    return new Response(
      typeof r.body === 'string' ? r.body : JSON.stringify(r.body),
      { status: r.status, headers },
    )
  }
  return Object.assign(fn, { calls })
}

function minimalMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg_1',
    conversation_id: 'dir_alice',
    sender: 'me',
    client_msg_id: 'cli_1',
    seq: 1,
    type: 'text',
    content: { text: 'hello' },
    metadata: {},
    status: 'stored',
    created_at: '2026-04-19T00:00:00Z',
    delivered_at: null,
    read_at: null,
    ...overrides,
  }
}

// ─── Factory ───────────────────────────────────────────────────────────

function makeRuntime(
  opts: {
    fetch?: typeof fetch
    handlers?: ChannelRuntimeHandlers
    cfg?: Record<string, unknown>
  } = {},
) {
  const timers = new TimerHarness()
  const runtime = new AgentchatChannelRuntime({
    config: makeConfig(opts.cfg),
    handlers: opts.handlers,
    logger: silentLogger(),
    fetch: opts.fetch,
    webSocketCtor: MockWebSocket as unknown as typeof import('ws').WebSocket,
    now: () => timers.now,
    random: () => 0.5,
    sleep: () => Promise.resolve(),
  })
  return { runtime, timers }
}

function bringUpReady(runtime: AgentchatChannelRuntime): MockWebSocket {
  runtime.start()
  const sock = mockInstances[mockInstances.length - 1]!
  sock.doOpen()
  sock.doMessage({ type: 'hello.ok', payload: {} })
  return sock
}

beforeEach(() => {
  mockInstances.length = 0
})
afterEach(() => {
  mockInstances.length = 0
})

// ─── Tests ─────────────────────────────────────────────────────────────

describe('AgentchatChannelRuntime — lifecycle', () => {
  it('start() opens WS; getHealth() reflects DISCONNECTED initially', () => {
    const { runtime } = makeRuntime()
    expect(runtime.getHealth().state.kind).toBe('DISCONNECTED')
    expect(runtime.getHealth().authenticated).toBe(false)
    runtime.start()
    expect(runtime.getHealth().state.kind).toBe('CONNECTING')
  })

  it('start() is idempotent', () => {
    const { runtime } = makeRuntime()
    runtime.start()
    runtime.start()
    runtime.start()
    expect(mockInstances.length).toBe(1)
  })

  it('onAuthenticated fires on HELLO_OK; authenticated flag flips to true', () => {
    const auths: number[] = []
    const { runtime } = makeRuntime({ handlers: { onAuthenticated: (at) => auths.push(at) } })
    bringUpReady(runtime)
    expect(auths).toHaveLength(1)
    expect(runtime.getHealth().authenticated).toBe(true)
    expect(runtime.getHealth().state.kind).toBe('READY')
  })

  it('onStateChanged fires for every transition', () => {
    const transitions: string[] = []
    const { runtime } = makeRuntime({
      handlers: { onStateChanged: (next) => transitions.push(next.kind) },
    })
    bringUpReady(runtime)
    expect(transitions).toEqual(['CONNECTING', 'AUTHENTICATING', 'READY'])
  })

  it('authenticated flips back to false when state leaves READY/DEGRADED', () => {
    const { runtime } = makeRuntime()
    const sock = bringUpReady(runtime)
    expect(runtime.getHealth().authenticated).toBe(true)
    sock.close(1006, 'abnormal')
    expect(runtime.getHealth().authenticated).toBe(false)
  })
})

function fullMessagePayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    conversation_id: 'dir_alice',
    sender: 'alice',
    client_msg_id: 'cli_1',
    seq: 1,
    type: 'text',
    content: { text: 'hi' },
    metadata: {},
    status: 'stored',
    created_at: '2026-04-19T00:00:00Z',
    ...overrides,
  }
}

describe('AgentchatChannelRuntime — inbound dispatch', () => {
  it('delivers normalized message events to onInbound', () => {
    const received: unknown[] = []
    const { runtime } = makeRuntime({
      handlers: {
        onInbound: (e) => {
          received.push(e)
        },
      },
    })
    const sock = bringUpReady(runtime)
    sock.doMessage({ type: 'message.new', payload: fullMessagePayload() })
    expect(received).toHaveLength(1)
    const ev = received[0] as { kind: string; conversationKind?: string }
    expect(ev.kind).toBe('message')
    expect(ev.conversationKind).toBe('direct')
  })

  it('group messages surface as kind=message with conversationKind=group', () => {
    const received: Array<{ kind: string; conversationKind?: string }> = []
    const { runtime } = makeRuntime({
      handlers: {
        onInbound: (e) => {
          received.push(e as { kind: string; conversationKind?: string })
        },
      },
    })
    const sock = bringUpReady(runtime)
    sock.doMessage({
      type: 'message.new',
      payload: fullMessagePayload({ id: 'm2', conversation_id: 'grp_team', sender: 'bob' }),
    })
    expect(received[0]?.kind).toBe('message')
    expect(received[0]?.conversationKind).toBe('group')
  })

  it('typing/presence/read-receipt events route through onInbound with correct kinds', () => {
    const received: Array<{ kind: string }> = []
    const { runtime } = makeRuntime({
      handlers: {
        onInbound: (e) => {
          received.push(e as { kind: string })
        },
      },
    })
    const sock = bringUpReady(runtime)
    sock.doMessage({
      type: 'typing.start',
      payload: { conversation_id: 'dir_alice', sender: 'alice' },
    })
    sock.doMessage({
      type: 'presence.update',
      payload: { handle: 'alice', status: 'online' },
    })
    sock.doMessage({
      type: 'message.read',
      payload: { conversation_id: 'dir_alice', reader: 'alice', through_seq: 5 },
    })
    const kinds = received.map((r) => r.kind)
    expect(kinds).toContain('typing')
    expect(kinds).toContain('presence')
    expect(kinds).toContain('read-receipt')
  })

  it('invokes onValidationError and keeps connection alive on malformed frame', () => {
    const validationErrors: string[] = []
    const received: unknown[] = []
    const { runtime } = makeRuntime({
      handlers: {
        onInbound: (e) => {
          received.push(e)
        },
        onValidationError: (err) => {
          validationErrors.push(err.class_)
        },
      },
    })
    const sock = bringUpReady(runtime)
    // message.new with empty payload will fail zod validation
    sock.doMessage({ type: 'message.new', payload: {} })
    expect(validationErrors).toContain('validation')
    expect(received).toHaveLength(0)
    expect(runtime.getHealth().state.kind).toBe('READY')
  })

  it('swallows errors thrown by onInbound handler without crashing dispatch', () => {
    const received: unknown[] = []
    const { runtime } = makeRuntime({
      handlers: {
        onInbound: (e) => {
          received.push(e)
          throw new Error('handler boom')
        },
      },
    })
    const sock = bringUpReady(runtime)
    expect(() =>
      sock.doMessage({ type: 'message.new', payload: fullMessagePayload() }),
    ).not.toThrow()
    expect(received).toHaveLength(1)
    expect(runtime.getHealth().state.kind).toBe('READY')
  })

  it('logs rejected async onInbound promise without crashing', async () => {
    const received: unknown[] = []
    const { runtime } = makeRuntime({
      handlers: {
        onInbound: async (e) => {
          received.push(e)
          throw new Error('async boom')
        },
      },
    })
    const sock = bringUpReady(runtime)
    sock.doMessage({ type: 'message.new', payload: fullMessagePayload() })
    // Let the promise reject and the .catch() run.
    await new Promise((r) => setImmediate(r))
    expect(received).toHaveLength(1)
    expect(runtime.getHealth().state.kind).toBe('READY')
  })
})

describe('AgentchatChannelRuntime — outbound', () => {
  it('sendMessage delegates through outbound adapter and returns SendResult', async () => {
    const fetchStub = makeFetch([{ status: 201, body: minimalMessage() }])
    const { runtime } = makeRuntime({ fetch: fetchStub })
    bringUpReady(runtime)
    const result = await runtime.sendMessage({
      kind: 'direct',
      to: 'alice',
      content: { text: 'hi' },
    })
    expect(result.message.id).toBe('msg_1')
    expect(fetchStub.calls).toHaveLength(1)
    expect(fetchStub.calls[0]?.url).toContain('/v1/messages')
  })

  it('onBacklogWarning handler fires when server reports backlog', async () => {
    const fetchStub = makeFetch([
      {
        status: 201,
        body: minimalMessage(),
        headers: { 'x-backlog-warning': 'alice=73' },
      },
    ])
    const warnings: Array<{ recipientHandle: string; undeliveredCount: number }> = []
    const { runtime } = makeRuntime({
      fetch: fetchStub,
      handlers: {
        onBacklogWarning: (w) =>
          warnings.push({ recipientHandle: w.recipientHandle, undeliveredCount: w.undeliveredCount }),
      },
    })
    bringUpReady(runtime)
    await runtime.sendMessage({ kind: 'direct', to: 'alice', content: { text: 'hi' } })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toEqual({ recipientHandle: 'alice', undeliveredCount: 73 })
  })

  it('sendWsAction returns true when READY and pushes frame', () => {
    const { runtime } = makeRuntime()
    const sock = bringUpReady(runtime)
    const ok = runtime.sendWsAction('typing.start', { conversation_id: 'dir_alice' })
    expect(ok).toBe(true)
    // [0] was HELLO, [1] is our action
    expect(sock.sent).toHaveLength(2)
    expect(JSON.parse(sock.sent[1]!)).toEqual({
      type: 'typing.start',
      payload: { conversation_id: 'dir_alice' },
    })
  })

  it('sendWsAction returns false when not READY', () => {
    const { runtime } = makeRuntime()
    expect(runtime.sendWsAction('typing.start', {})).toBe(false)
  })
})

describe('AgentchatChannelRuntime — health snapshot', () => {
  it('getHealth reports outbound queue depth + circuit state', async () => {
    const fetchStub = makeFetch([{ status: 201, body: minimalMessage() }])
    const { runtime } = makeRuntime({ fetch: fetchStub })
    bringUpReady(runtime)
    const pre = runtime.getHealth()
    expect(pre.outbound.inFlight).toBe(0)
    expect(pre.outbound.queued).toBe(0)
    expect(pre.outbound.circuitState).toBe('closed')

    await runtime.sendMessage({ kind: 'direct', to: 'alice', content: { text: 'hi' } })
    const post = runtime.getHealth()
    expect(post.outbound.inFlight).toBe(0)
    expect(post.outbound.circuitState).toBe('closed')
  })
})

describe('AgentchatChannelRuntime — stop / drain', () => {
  it('stop() transitions WS through DRAINING → CLOSED; promise resolves once closed', async () => {
    const transitions: string[] = []
    const { runtime, timers } = makeRuntime({
      handlers: { onStateChanged: (s) => transitions.push(s.kind) },
    })
    bringUpReady(runtime)
    const stopping = runtime.stop(timers.now + 5_000)
    // pollUntilIdle runs synchronously when outbound is already idle, so
    // DRAINING may be visited within the same microtask. Assert the
    // sequence was observed via the transitions recorder instead.
    await stopping
    expect(runtime.getHealth().state.kind).toBe('CLOSED')
    expect(transitions).toContain('DRAINING')
    expect(transitions).toContain('CLOSED')
  })

  it('stop() is idempotent — multiple calls return the same promise', () => {
    const { runtime } = makeRuntime()
    bringUpReady(runtime)
    const p1 = runtime.stop()
    const p2 = runtime.stop()
    expect(p1).toBe(p2)
  })
})

describe('AgentchatChannelRuntime — onError', () => {
  it('onError fires when WS client emits validation error from bad frame', () => {
    const errs: string[] = []
    const { runtime } = makeRuntime({
      handlers: { onError: (e) => errs.push(e.class_) },
    })
    const sock = bringUpReady(runtime)
    sock.doMessage('not-json-at-all')
    expect(errs).toContain('validation')
  })

  it('swallows errors thrown by onError handler', () => {
    const { runtime } = makeRuntime({
      handlers: {
        onError: () => {
          throw new Error('handler boom')
        },
      },
    })
    const sock = bringUpReady(runtime)
    expect(() => sock.doMessage('not-json')).not.toThrow()
  })
})
