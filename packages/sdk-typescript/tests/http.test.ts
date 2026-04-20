import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HttpTransport } from '../src/http.js'
import {
  AgentChatError,
  RateLimitedError,
  NotFoundError,
  SuspendedError,
  ValidationError,
  UnauthorizedError,
  ServerError,
  ConnectionError,
} from '../src/errors.js'

/**
 * Builds a `fetch` stub that returns the next scripted response on each call.
 * Each script entry is either a `Response` to return or a function that
 * receives the input + init and returns a `Response` (used when the test
 * wants to assert on the URL / headers / body).
 */
function scriptedFetch(
  responses: Array<
    Response | ((input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>)
  >,
): typeof fetch {
  let i = 0
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const entry = responses[i++]
    if (!entry) throw new Error(`scriptedFetch: unexpected call #${i}`)
    return typeof entry === 'function' ? await entry(input, init) : entry
  }) as unknown as typeof fetch
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

describe('HttpTransport', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('returns parsed JSON on 2xx', async () => {
    const fetch = scriptedFetch([jsonResponse(200, { hello: 'world' })])
    const http = new HttpTransport({ baseUrl: 'https://api.test', fetch })
    const res = await http.request<{ hello: string }>('GET', '/ping')
    expect(res.data).toEqual({ hello: 'world' })
    expect(res.status).toBe(200)
  })

  it('throws typed error on 404', async () => {
    const fetch = scriptedFetch([jsonResponse(404, { code: 'AGENT_NOT_FOUND', message: 'no such agent' })])
    const http = new HttpTransport({ baseUrl: 'https://api.test', fetch })
    await expect(http.request('GET', '/v1/agents/@who')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('throws RateLimitedError on 429 and exposes retryAfterMs from header', async () => {
    const fetch = scriptedFetch([
      jsonResponse(429, { code: 'RATE_LIMITED', message: 'slow down' }, { 'Retry-After': '7' }),
    ])
    const http = new HttpTransport({
      baseUrl: 'https://api.test',
      fetch,
      retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
    })
    try {
      await http.request('POST', '/v1/messages', { body: { x: 1 }, retry: 'never' })
      expect.fail('expected RateLimitedError')
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitedError)
      expect((err as RateLimitedError).retryAfterMs).toBe(7000)
    }
  })

  it('retries 5xx up to maxRetries then throws ServerError', async () => {
    const fetch = scriptedFetch([
      jsonResponse(503, { code: 'INTERNAL_ERROR', message: 'try later' }),
      jsonResponse(503, { code: 'INTERNAL_ERROR', message: 'try later' }),
      jsonResponse(503, { code: 'INTERNAL_ERROR', message: 'try later' }),
    ])
    const http = new HttpTransport({
      baseUrl: 'https://api.test',
      fetch,
      retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 },
    })
    await expect(http.request('GET', '/ping')).rejects.toBeInstanceOf(ServerError)
    expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(3)
  })

  it('succeeds after retry when server recovers', async () => {
    const fetch = scriptedFetch([
      jsonResponse(500, { code: 'INTERNAL_ERROR', message: 'boom' }),
      jsonResponse(200, { ok: true }),
    ])
    const http = new HttpTransport({
      baseUrl: 'https://api.test',
      fetch,
      retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 },
    })
    const res = await http.request<{ ok: boolean }>('GET', '/ping')
    expect(res.data).toEqual({ ok: true })
  })

  it('never retries a POST without an idempotency opt-in', async () => {
    const fetch = scriptedFetch([
      jsonResponse(503, { code: 'INTERNAL_ERROR', message: 'boom' }),
    ])
    const http = new HttpTransport({
      baseUrl: 'https://api.test',
      fetch,
      retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 2 },
    })
    await expect(
      http.request('POST', '/v1/contacts', { body: { handle: '@a' } }),
    ).rejects.toBeInstanceOf(ServerError)
    expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1)
  })

  it('retries a POST when retry:"auto" is set', async () => {
    const fetch = scriptedFetch([
      jsonResponse(503, { code: 'INTERNAL_ERROR', message: 'boom' }),
      jsonResponse(200, { ok: true }),
    ])
    const http = new HttpTransport({
      baseUrl: 'https://api.test',
      fetch,
      retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 },
    })
    const res = await http.request<{ ok: boolean }>('POST', '/v1/messages', {
      body: { x: 1 },
      retry: 'auto',
    })
    expect(res.data).toEqual({ ok: true })
  })

  it('retries a POST when an idempotency key is supplied', async () => {
    let seenKey = ''
    const fetch = scriptedFetch([
      (_, init) => {
        const headers = new Headers(init!.headers as HeadersInit)
        seenKey = headers.get('idempotency-key') ?? ''
        return new Response(JSON.stringify({ code: 'INTERNAL_ERROR', message: 'boom' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        })
      },
      jsonResponse(200, { ok: true }),
    ])
    const http = new HttpTransport({
      baseUrl: 'https://api.test',
      fetch,
      retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 },
    })
    await http.request('POST', '/v1/any', {
      body: { x: 1 },
      idempotencyKey: 'abc-123',
    })
    expect(seenKey).toBe('abc-123')
  })

  it('400 VALIDATION_ERROR is not retried', async () => {
    const fetch = scriptedFetch([
      jsonResponse(400, { code: 'VALIDATION_ERROR', message: 'bad body' }),
    ])
    const http = new HttpTransport({
      baseUrl: 'https://api.test',
      fetch,
      retry: { maxRetries: 5, baseDelayMs: 1, maxDelayMs: 2 },
    })
    await expect(http.request('GET', '/ping')).rejects.toBeInstanceOf(ValidationError)
    expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1)
  })

  it('maps SUSPENDED code to SuspendedError', async () => {
    const fetch = scriptedFetch([
      jsonResponse(403, { code: 'SUSPENDED', message: 'account suspended' }),
    ])
    const http = new HttpTransport({ baseUrl: 'https://api.test', fetch })
    await expect(http.request('GET', '/ping')).rejects.toBeInstanceOf(SuspendedError)
  })

  it('maps UNAUTHORIZED to UnauthorizedError', async () => {
    const fetch = scriptedFetch([
      jsonResponse(401, { code: 'UNAUTHORIZED', message: 'bad key' }),
    ])
    const http = new HttpTransport({ baseUrl: 'https://api.test', fetch })
    await expect(http.request('GET', '/ping')).rejects.toBeInstanceOf(UnauthorizedError)
  })

  it('falls back to AgentChatError for unknown codes', async () => {
    const fetch = scriptedFetch([
      jsonResponse(400, { code: 'SOMETHING_NEW', message: 'the future' }),
    ])
    const http = new HttpTransport({ baseUrl: 'https://api.test', fetch })
    try {
      await http.request('GET', '/ping')
      expect.fail('should throw')
    } catch (err) {
      expect(err).toBeInstanceOf(AgentChatError)
      expect((err as AgentChatError).code).toBe('SOMETHING_NEW')
    }
  })

  it('honors caller AbortSignal', async () => {
    const fetch = vi.fn(async (_: RequestInfo | URL, init?: RequestInit) => {
      // Wait until aborted, then reject as native fetch would.
      await new Promise<void>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
      throw new Error('unreachable')
    }) as unknown as typeof globalThis.fetch
    const http = new HttpTransport({ baseUrl: 'https://api.test', fetch })
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 10)
    try {
      await http.request('GET', '/ping', { signal: ctrl.signal, timeoutMs: 0 })
      expect.fail('should throw')
    } catch (err) {
      expect((err as Error).name).toBe('AbortError')
    }
  })

  it('redacts Authorization from hook info', async () => {
    const fetch = scriptedFetch([jsonResponse(200, { ok: true })])
    const onRequest = vi.fn()
    const http = new HttpTransport({
      baseUrl: 'https://api.test',
      apiKey: 'super-secret',
      fetch,
      hooks: { onRequest },
    })
    await http.request('GET', '/ping')
    expect(onRequest).toHaveBeenCalledOnce()
    const info = onRequest.mock.calls[0][0]
    expect(info.headers.Authorization).toBe('Bearer ***')
    expect(JSON.stringify(info.headers)).not.toContain('super-secret')
  })

  it('invokes onRetry between attempts', async () => {
    const fetch = scriptedFetch([
      jsonResponse(503, { code: 'INTERNAL_ERROR', message: 'boom' }),
      jsonResponse(200, { ok: true }),
    ])
    const onRetry = vi.fn()
    const http = new HttpTransport({
      baseUrl: 'https://api.test',
      fetch,
      retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 },
      hooks: { onRetry },
    })
    await http.request('GET', '/ping')
    expect(onRetry).toHaveBeenCalledOnce()
    const info = onRetry.mock.calls[0][0]
    expect(info.nextAttempt).toBe(2)
    expect(info.status).toBe(503)
  })

  it('retries on network failure when method is idempotent', async () => {
    const fetch = scriptedFetch([
      () => Promise.reject(new TypeError('socket hang up')),
      jsonResponse(200, { ok: true }),
    ])
    const http = new HttpTransport({
      baseUrl: 'https://api.test',
      fetch,
      retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 },
    })
    const res = await http.request<{ ok: boolean }>('GET', '/ping')
    expect(res.data).toEqual({ ok: true })
  })

  it('surfaces ConnectionError when network fails and retries exhausted', async () => {
    const fetch = scriptedFetch([
      () => Promise.reject(new TypeError('socket hang up')),
    ])
    const http = new HttpTransport({
      baseUrl: 'https://api.test',
      fetch,
      retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
    })
    await expect(http.request('GET', '/ping')).rejects.toBeInstanceOf(ConnectionError)
  })

  it('parses 204 No Content as undefined', async () => {
    const fetch = scriptedFetch([new Response(null, { status: 204 })])
    const http = new HttpTransport({ baseUrl: 'https://api.test', fetch })
    const res = await http.request<void>('DELETE', '/v1/contacts/@a')
    expect(res.data).toBeUndefined()
    expect(res.status).toBe(204)
  })

  it('sends JSON body with Content-Type', async () => {
    let contentType = ''
    let rawBody = ''
    const fetch = scriptedFetch([
      (_, init) => {
        const h = new Headers(init!.headers as HeadersInit)
        contentType = h.get('content-type') ?? ''
        rawBody = init!.body as string
        return jsonResponse(200, { ok: true })
      },
    ])
    const http = new HttpTransport({ baseUrl: 'https://api.test', fetch })
    await http.request('POST', '/v1/things', { body: { a: 1 } })
    expect(contentType).toBe('application/json')
    expect(JSON.parse(rawBody)).toEqual({ a: 1 })
  })

  it('attaches a default User-Agent identifying the SDK + runtime', async () => {
    let ua = ''
    const fetch = scriptedFetch([
      (_, init) => {
        ua = new Headers(init!.headers as HeadersInit).get('user-agent') ?? ''
        return jsonResponse(200, { ok: true })
      },
    ])
    const http = new HttpTransport({ baseUrl: 'https://api.test', fetch })
    await http.request('GET', '/ping')
    expect(ua).toMatch(/^agentchat-ts\/\S+ \S+\/\S+$/)
  })

  it('honors a custom User-Agent override', async () => {
    let ua = ''
    const fetch = scriptedFetch([
      (_, init) => {
        ua = new Headers(init!.headers as HeadersInit).get('user-agent') ?? ''
        return jsonResponse(200, { ok: true })
      },
    ])
    const http = new HttpTransport({
      baseUrl: 'https://api.test',
      fetch,
      userAgent: 'my-bot/1.0',
    })
    await http.request('GET', '/ping')
    expect(ua).toBe('my-bot/1.0')
  })

  it('omits User-Agent when explicitly set to null', async () => {
    let seen: string | null = ''
    const fetch = scriptedFetch([
      (_, init) => {
        seen = new Headers(init!.headers as HeadersInit).get('user-agent')
        return jsonResponse(200, { ok: true })
      },
    ])
    const http = new HttpTransport({
      baseUrl: 'https://api.test',
      fetch,
      userAgent: null,
    })
    await http.request('GET', '/ping')
    expect(seen).toBeNull()
  })

  it('surfaces x-request-id on successful responses', async () => {
    const fetch = scriptedFetch([
      jsonResponse(200, { ok: true }, { 'x-request-id': 'req_abc' }),
    ])
    const http = new HttpTransport({ baseUrl: 'https://api.test', fetch })
    const res = await http.request('GET', '/ping')
    expect(res.requestId).toBe('req_abc')
  })

  it('returns requestId=null when the header is missing', async () => {
    const fetch = scriptedFetch([jsonResponse(200, { ok: true })])
    const http = new HttpTransport({ baseUrl: 'https://api.test', fetch })
    const res = await http.request('GET', '/ping')
    expect(res.requestId).toBeNull()
  })

  it('surfaces x-request-id on error instances', async () => {
    const fetch = scriptedFetch([
      jsonResponse(
        403,
        { code: 'SUSPENDED', message: 'nope' },
        { 'x-request-id': 'req_xyz' },
      ),
    ])
    const http = new HttpTransport({ baseUrl: 'https://api.test', fetch })
    try {
      await http.request('GET', '/ping')
      expect.fail('should throw')
    } catch (err) {
      expect(err).toBeInstanceOf(SuspendedError)
      expect((err as SuspendedError).requestId).toBe('req_xyz')
    }
  })
})
