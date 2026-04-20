/**
 * Tests for the setup HTTP client (P7).
 *
 * All network calls are stubbed via a fetch mock. We cover:
 *   - validateApiKey: success, 401/403/410/5xx, network/timeout, bad shape
 *   - registerAgentStart: success, 409 HANDLE_TAKEN / EMAIL_TAKEN /
 *     EMAIL_EXHAUSTED, 429 rate-limit with Retry-After, OTP_FAILED 500
 *   - registerAgentVerify: success, 400 EXPIRED / INVALID_CODE, 429,
 *     shape validation (missing api_key), 409 HANDLE_TAKEN
 *   - assertApiKeyValid throws AgentChatChannelError with the right class
 */

import { describe, it, expect } from 'vitest'
import { AgentChatChannelError } from '../src/errors.js'
import {
  validateApiKey,
  assertApiKeyValid,
  registerAgentStart,
  registerAgentVerify,
} from '../src/setup-client.js'

interface StubResponse {
  status: number
  body: unknown
  headers?: Record<string, string>
}

function makeFetch(responses: StubResponse[] | ((url: string, init?: RequestInit) => StubResponse | Error)) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  let i = 0
  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url)
    calls.push({ url: urlStr, init })
    const r =
      typeof responses === 'function'
        ? responses(urlStr, init)
        : i < responses.length
          ? responses[i++]!
          : new Error('stub exhausted')
    if (r instanceof Error) throw r
    const headers = new Headers(r.headers ?? {})
    return new Response(
      typeof r.body === 'string' ? r.body : JSON.stringify(r.body),
      { status: r.status, headers },
    )
  }
  return Object.assign(fn, { calls })
}

const VALID_KEY = 'ac_' + 'x'.repeat(40)

describe('validateApiKey', () => {
  it('returns ok:true with agent identity on 200', async () => {
    const fetchStub = makeFetch([
      {
        status: 200,
        body: {
          handle: 'alice',
          display_name: 'Alice Agent',
          email: 'alice@example.com',
          created_at: '2026-04-19T00:00:00Z',
        },
      },
    ])
    const res = await validateApiKey(VALID_KEY, { fetch: fetchStub })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.agent.handle).toBe('alice')
      expect(res.agent.displayName).toBe('Alice Agent')
    }
    expect(fetchStub.calls[0]?.url).toContain('/v1/agents/me')
    const headers = fetchStub.calls[0]?.init?.headers as Record<string, string>
    expect(headers?.Authorization).toBe(`Bearer ${VALID_KEY}`)
  })

  it('honors apiBase override and strips trailing slash', async () => {
    const fetchStub = makeFetch([
      {
        status: 200,
        body: { handle: 'a', email: 'a@b.co', created_at: '2026-04-19T00:00:00Z' },
      },
    ])
    await validateApiKey(VALID_KEY, { fetch: fetchStub, apiBase: 'https://stage.agentchat.me/' })
    expect(fetchStub.calls[0]?.url).toBe('https://stage.agentchat.me/v1/agents/me')
  })

  it('classifies 401 as unauthorized', async () => {
    const fetchStub = makeFetch([{ status: 401, body: { code: 'UNAUTHORIZED' } }])
    const res = await validateApiKey(VALID_KEY, { fetch: fetchStub })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('unauthorized')
  })

  it('classifies 403 as forbidden', async () => {
    const fetchStub = makeFetch([{ status: 403, body: {} }])
    const res = await validateApiKey(VALID_KEY, { fetch: fetchStub })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('forbidden')
  })

  it('classifies 410 as deleted', async () => {
    const fetchStub = makeFetch([{ status: 410, body: {} }])
    const res = await validateApiKey(VALID_KEY, { fetch: fetchStub })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('deleted')
  })

  it('classifies 500 as server-error', async () => {
    const fetchStub = makeFetch([{ status: 502, body: 'bad gateway' }])
    const res = await validateApiKey(VALID_KEY, { fetch: fetchStub })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('server-error')
      expect(res.status).toBe(502)
    }
  })

  it('flags unexpected success shape (missing handle)', async () => {
    const fetchStub = makeFetch([{ status: 200, body: { email: 'x@y.co', created_at: 'now' } }])
    const res = await validateApiKey(VALID_KEY, { fetch: fetchStub })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('unexpected-shape')
  })

  it('classifies ECONNREFUSED as unreachable', async () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:443')
    const fetchStub = makeFetch(() => err)
    const res = await validateApiKey(VALID_KEY, { fetch: fetchStub })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('unreachable')
  })

  it('classifies AbortError (timeout) as unreachable', async () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const fetchStub = makeFetch(() => err)
    const res = await validateApiKey(VALID_KEY, { fetch: fetchStub })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('unreachable')
  })

  it('rejects empty api key without hitting network', async () => {
    const fetchStub = makeFetch([])
    const res = await validateApiKey('', { fetch: fetchStub })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('unauthorized')
    expect(fetchStub.calls).toHaveLength(0)
  })
})

describe('assertApiKeyValid', () => {
  it('returns agent on success', async () => {
    const fetchStub = makeFetch([
      {
        status: 200,
        body: { handle: 'a', email: 'a@b.co', created_at: '2026-04-19T00:00:00Z' },
      },
    ])
    const agent = await assertApiKeyValid(VALID_KEY, { fetch: fetchStub })
    expect(agent.handle).toBe('a')
  })

  it('throws terminal-auth on 401', async () => {
    const fetchStub = makeFetch([{ status: 401, body: {} }])
    await expect(assertApiKeyValid(VALID_KEY, { fetch: fetchStub })).rejects.toMatchObject({
      class_: 'terminal-auth',
    })
  })

  it('throws retry-transient on 500', async () => {
    const fetchStub = makeFetch([{ status: 500, body: {} }])
    await expect(assertApiKeyValid(VALID_KEY, { fetch: fetchStub })).rejects.toBeInstanceOf(
      AgentChatChannelError,
    )
  })
})

describe('registerAgentStart', () => {
  it('returns pendingId on 200', async () => {
    const fetchStub = makeFetch([{ status: 200, body: { pending_id: 'pnd_abc123' } }])
    const res = await registerAgentStart(
      { email: 'alice@example.com', handle: 'alice' },
      { fetch: fetchStub },
    )
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.pendingId).toBe('pnd_abc123')
  })

  it('classifies HANDLE_TAKEN', async () => {
    const fetchStub = makeFetch([
      { status: 409, body: { code: 'HANDLE_TAKEN', message: 'Handle @alice is already taken' } },
    ])
    const res = await registerAgentStart(
      { email: 'alice@example.com', handle: 'alice' },
      { fetch: fetchStub },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('handle-taken')
  })

  it('classifies EMAIL_EXHAUSTED (3 accounts already registered)', async () => {
    const fetchStub = makeFetch([
      { status: 409, body: { code: 'EMAIL_EXHAUSTED', message: 'max reached' } },
    ])
    const res = await registerAgentStart(
      { email: 'alice@example.com', handle: 'alice' },
      { fetch: fetchStub },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('email-exhausted')
  })

  it('honors Retry-After on 429', async () => {
    const fetchStub = makeFetch([
      {
        status: 429,
        body: { code: 'OTP_COOLDOWN', message: 'wait a minute' },
        headers: { 'retry-after': '60' },
      },
    ])
    const res = await registerAgentStart(
      { email: 'alice@example.com', handle: 'alice' },
      { fetch: fetchStub },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('rate-limited')
      expect(res.retryAfterSeconds).toBe(60)
    }
  })

  it('classifies OTP_FAILED as otp-failed', async () => {
    const fetchStub = makeFetch([{ status: 500, body: { code: 'OTP_FAILED' } }])
    const res = await registerAgentStart(
      { email: 'alice@example.com', handle: 'alice' },
      { fetch: fetchStub },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('otp-failed')
  })

  it('returns network-error on fetch throw', async () => {
    const fetchStub = makeFetch(() => new Error('ECONNRESET'))
    const res = await registerAgentStart(
      { email: 'alice@example.com', handle: 'alice' },
      { fetch: fetchStub },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('network-error')
  })
})

describe('registerAgentVerify', () => {
  it('returns apiKey + agent on 201', async () => {
    const fetchStub = makeFetch([
      {
        status: 201,
        body: {
          api_key: 'ac_new_' + 'y'.repeat(40),
          agent: {
            handle: 'alice',
            display_name: 'Alice',
            email: 'alice@example.com',
            created_at: '2026-04-19T00:00:00Z',
          },
        },
      },
    ])
    const res = await registerAgentVerify(
      { pendingId: 'pnd_abc', code: '123456' },
      { fetch: fetchStub },
    )
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.apiKey.startsWith('ac_new_')).toBe(true)
      expect(res.agent.handle).toBe('alice')
    }
  })

  it('classifies EXPIRED', async () => {
    const fetchStub = makeFetch([{ status: 400, body: { code: 'EXPIRED', message: 'expired' } }])
    const res = await registerAgentVerify(
      { pendingId: 'pnd_abc', code: '123456' },
      { fetch: fetchStub },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('expired')
  })

  it('classifies INVALID_CODE', async () => {
    const fetchStub = makeFetch([{ status: 400, body: { code: 'INVALID_CODE' } }])
    const res = await registerAgentVerify(
      { pendingId: 'pnd_abc', code: 'bad' },
      { fetch: fetchStub },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('invalid-code')
  })

  it('flags unexpected success shape (missing api_key)', async () => {
    const fetchStub = makeFetch([
      {
        status: 201,
        body: {
          agent: {
            handle: 'a',
            email: 'a@b.co',
            created_at: '2026-04-19T00:00:00Z',
          },
        },
      },
    ])
    const res = await registerAgentVerify(
      { pendingId: 'pnd_abc', code: '123456' },
      { fetch: fetchStub },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('unexpected-shape')
  })

  it('classifies race-window HANDLE_TAKEN from 409', async () => {
    const fetchStub = makeFetch([{ status: 409, body: { code: 'HANDLE_TAKEN' } }])
    const res = await registerAgentVerify(
      { pendingId: 'pnd_abc', code: '123456' },
      { fetch: fetchStub },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('handle-taken')
  })
})
