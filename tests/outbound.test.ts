/**
 * Tests for the outbound adapter.
 *
 * We stub `fetch` with a hand-rolled mock that records the request, lets
 * the test control the response, and supports sequenced responses (first
 * attempt errors, second succeeds, etc). All time is controlled via the
 * retry policy's `sleep` override so tests run in ms, not seconds.
 */

import { describe, it, expect } from 'vitest'
import {
  OutboundAdapter,
  type OutboundMessageInput,
} from '../src/outbound.js'
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
    if (i >= responses.length) {
      throw new Error('stub exhausted')
    }
    const r = responses[i++]!
    const headers = new Headers(r.headers ?? {})
    return new Response(
      typeof r.body === 'string' ? r.body : JSON.stringify(r.body),
      { status: r.status, headers },
    )
  }
  return Object.assign(fn, { calls })
}

function makeAdapter(overrides: { fetch: typeof fetch; retryDelays?: number[] }) {
  const config = parseChannelConfig({
    apiKey: VALID_KEY,
    apiBase: 'https://api.agentchat.me',
  })
  const sleeps: number[] = []
  return {
    adapter: new OutboundAdapter({
      config,
      logger: silentLogger(),
      metrics: createNoopMetrics(),
      fetch: overrides.fetch,
      retryPolicy: {
        maxAttempts: 3,
        initialBackoffMs: 10,
        // Needs to accommodate realistic Retry-After values (seconds).
        maxBackoffMs: 60_000,
        jitterRatio: 0,
      },
      sleep: (ms) => {
        sleeps.push(ms)
        return Promise.resolve()
      },
      random: () => 0.5,
    }),
    sleeps,
  }
}

const directInput: OutboundMessageInput = {
  kind: 'direct',
  to: 'alice',
  content: { text: 'hello' },
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

describe('OutboundAdapter — happy path', () => {
  it('sends a direct message and returns the server message', async () => {
    const fetchStub = makeFetch([{ status: 201, body: minimalMessage() }])
    const { adapter } = makeAdapter({ fetch: fetchStub })

    const result = await adapter.sendMessage(directInput)
    expect(result.message.id).toBe('msg_1')
    expect(result.idempotentReplay).toBe(false)
    expect(result.attempts).toBe(1)

    expect(fetchStub.calls).toHaveLength(1)
    const body = JSON.parse(String(fetchStub.calls[0]!.init!.body))
    expect(body.to).toBe('alice')
    expect(body.content.text).toBe('hello')
    expect(typeof body.client_msg_id).toBe('string')
    expect(body.client_msg_id.length).toBeGreaterThan(0)

    const headers = fetchStub.calls[0]!.init!.headers as Record<string, string>
    expect(headers['authorization']).toBe(`Bearer ${VALID_KEY}`)
  })

  it('sends a group message via conversation_id', async () => {
    const fetchStub = makeFetch([
      { status: 201, body: minimalMessage({ conversation_id: 'grp_team' }) },
    ])
    const { adapter } = makeAdapter({ fetch: fetchStub })
    await adapter.sendMessage({
      kind: 'group',
      conversationId: 'grp_team',
      content: { text: 'hi team' },
    })
    const body = JSON.parse(String(fetchStub.calls[0]!.init!.body))
    expect(body.conversation_id).toBe('grp_team')
    expect(body.to).toBeUndefined()
  })

  it('reuses caller-supplied clientMsgId', async () => {
    const fetchStub = makeFetch([{ status: 201, body: minimalMessage() }])
    const { adapter } = makeAdapter({ fetch: fetchStub })
    await adapter.sendMessage({ ...directInput, clientMsgId: 'cli_specific' })
    const body = JSON.parse(String(fetchStub.calls[0]!.init!.body))
    expect(body.client_msg_id).toBe('cli_specific')
  })

  it('surfaces idempotent replay from response header', async () => {
    const fetchStub = makeFetch([
      { status: 200, body: minimalMessage(), headers: { 'idempotent-replay': 'true' } },
    ])
    const { adapter } = makeAdapter({ fetch: fetchStub })
    const result = await adapter.sendMessage(directInput)
    expect(result.idempotentReplay).toBe(true)
  })

  it('surfaces backlog warning and fires callback', async () => {
    const fetchStub = makeFetch([
      {
        status: 201,
        body: minimalMessage(),
        headers: { 'x-backlog-warning': 'alice=6500' },
      },
    ])
    const config = parseChannelConfig({ apiKey: VALID_KEY })
    const warnings: unknown[] = []
    const adapter = new OutboundAdapter({
      config,
      logger: silentLogger(),
      metrics: createNoopMetrics(),
      fetch: fetchStub,
      onBacklogWarning: (w) => warnings.push(w),
    })
    const result = await adapter.sendMessage(directInput)
    expect(result.backlogWarning).toEqual({ recipientHandle: 'alice', undeliveredCount: 6500 })
    expect(warnings).toHaveLength(1)
  })

  it('includes x-request-id in the result when present', async () => {
    const fetchStub = makeFetch([
      { status: 201, body: minimalMessage(), headers: { 'x-request-id': 'req_123' } },
    ])
    const { adapter } = makeAdapter({ fetch: fetchStub })
    const result = await adapter.sendMessage(directInput)
    expect(result.requestId).toBe('req_123')
  })
})

describe('OutboundAdapter — retry + error classes', () => {
  it('retries on 500 and succeeds on second attempt', async () => {
    const fetchStub = makeFetch([
      { status: 500, body: { code: 'INTERNAL_ERROR', message: 'oops' } },
      { status: 201, body: minimalMessage() },
    ])
    const { adapter, sleeps } = makeAdapter({ fetch: fetchStub })
    const result = await adapter.sendMessage(directInput)
    expect(result.attempts).toBe(2)
    expect(sleeps).toEqual([10])
  })

  it('honors Retry-After on 429', async () => {
    const fetchStub = makeFetch([
      {
        status: 429,
        body: { code: 'RATE_LIMITED', message: 'slow down' },
        headers: { 'retry-after': '2' },
      },
      { status: 201, body: minimalMessage() },
    ])
    const { adapter, sleeps } = makeAdapter({ fetch: fetchStub })
    await adapter.sendMessage(directInput)
    expect(sleeps[0]).toBe(2000)
  })

  it('throws terminal-auth on 401 without retry', async () => {
    const fetchStub = makeFetch([
      { status: 401, body: { code: 'UNAUTHORIZED', message: 'bad key' } },
    ])
    const { adapter } = makeAdapter({ fetch: fetchStub })
    try {
      await adapter.sendMessage(directInput)
      expect.fail('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(AgentChatChannelError)
      expect((e as AgentChatChannelError).class_).toBe('terminal-auth')
    }
    expect(fetchStub.calls).toHaveLength(1)
  })

  it('throws terminal-user on 400 validation without retry', async () => {
    const fetchStub = makeFetch([
      { status: 400, body: { code: 'VALIDATION_ERROR', message: 'bad input' } },
    ])
    const { adapter } = makeAdapter({ fetch: fetchStub })
    try {
      await adapter.sendMessage(directInput)
      expect.fail('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(AgentChatChannelError)
      expect((e as AgentChatChannelError).class_).toBe('terminal-user')
    }
  })

  it('throws idempotent-replay on 409', async () => {
    const fetchStub = makeFetch([
      { status: 409, body: { code: 'DUPLICATE', message: 'duplicate' } },
    ])
    const { adapter } = makeAdapter({ fetch: fetchStub })
    try {
      await adapter.sendMessage(directInput)
      expect.fail('should have thrown')
    } catch (e) {
      expect((e as AgentChatChannelError).class_).toBe('idempotent-replay')
    }
  })

  it('classifies network error as retry-transient', async () => {
    const errors = [new Error('ECONNRESET'), null]
    let i = 0
    const fetchStub = Object.assign(
      async (_url: string | URL | Request, _init?: RequestInit) => {
        const err = errors[i++]
        if (err) throw err
        return new Response(JSON.stringify(minimalMessage()), { status: 201 })
      },
      { calls: [] as { url: string }[] },
    )
    const { adapter, sleeps } = makeAdapter({ fetch: fetchStub })
    const result = await adapter.sendMessage(directInput)
    expect(result.attempts).toBe(2)
    expect(sleeps).toEqual([10])
  })

  it('rejects empty content with terminal-user', async () => {
    const fetchStub = makeFetch([])
    const { adapter } = makeAdapter({ fetch: fetchStub })
    await expect(
      adapter.sendMessage({ kind: 'direct', to: 'alice', content: {} }),
    ).rejects.toThrow(/empty content/)
    expect(fetchStub.calls).toHaveLength(0)
  })
})

describe('OutboundAdapter — circuit breaker', () => {
  it('fast-fails once the breaker opens', async () => {
    // Threshold=2 so a tiny fixture can open it.
    const config = parseChannelConfig({ apiKey: VALID_KEY })
    const fetchStub = makeFetch([
      { status: 500, body: {} },
      { status: 500, body: {} },
      { status: 500, body: {} },
      { status: 500, body: {} },
      { status: 500, body: {} },
      { status: 500, body: {} },
      { status: 500, body: {} },
      { status: 500, body: {} },
      { status: 500, body: {} },
      { status: 500, body: {} },
      { status: 500, body: {} },
    ])
    const adapter = new OutboundAdapter({
      config,
      logger: silentLogger(),
      metrics: createNoopMetrics(),
      fetch: fetchStub,
      retryPolicy: {
        maxAttempts: 2,
        initialBackoffMs: 1,
        maxBackoffMs: 1,
        jitterRatio: 0,
      },
      sleep: () => Promise.resolve(),
      circuitBreaker: { failureThreshold: 2, windowMs: 60_000, cooldownMs: 1000 },
    })
    await expect(adapter.sendMessage(directInput)).rejects.toThrow()
    await expect(adapter.sendMessage(directInput)).rejects.toThrow()
    // Third call should fast-fail with "circuit open".
    await expect(adapter.sendMessage(directInput)).rejects.toThrow(/circuit open/)
    // 4 calls total: 2 per failing send × 2 (before circuit opens), none after.
    expect(fetchStub.calls.length).toBe(4)
  })
})

describe('OutboundAdapter — backpressure', () => {
  it('queues over the maxInFlight cap and drains as slots free up', async () => {
    const config = parseChannelConfig({
      apiKey: VALID_KEY,
      outbound: { maxInFlight: 1, sendTimeoutMs: 15000 },
    })
    const resolveBody: Array<() => void> = []
    const pending = new Set<Promise<unknown>>()
    const fetchStub = Object.assign(
      (_url: string | URL | Request, _init?: RequestInit) => {
        const p = new Promise<Response>((resolve) => {
          resolveBody.push(() => resolve(new Response(JSON.stringify(minimalMessage()), { status: 201 })))
        })
        pending.add(p)
        return p
      },
      { calls: [] as unknown[] },
    )
    const adapter = new OutboundAdapter({
      config,
      logger: silentLogger(),
      metrics: createNoopMetrics(),
      fetch: fetchStub as unknown as typeof fetch,
    })

    const p1 = adapter.sendMessage(directInput)
    const p2 = adapter.sendMessage(directInput)
    // Yield so p1's fetch gets invoked (promise chain microtask).
    await Promise.resolve()
    await Promise.resolve()
    // Only one should be in flight; second is queued.
    expect(adapter.snapshot().inFlight).toBe(1)
    expect(adapter.snapshot().queued).toBe(1)

    resolveBody[0]!()
    await p1
    // Yield again so the newly-promoted p2 has a chance to invoke fetch.
    await Promise.resolve()
    await Promise.resolve()
    expect(resolveBody.length).toBe(2)
    resolveBody[1]!()
    await p2
    expect(adapter.snapshot().inFlight).toBe(0)
    expect(adapter.snapshot().queued).toBe(0)
  })
})
