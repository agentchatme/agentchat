import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'

// HTTP-surface tests for the agent-avatar endpoints. Pins the route's
// translation work:
//
//   - auth: only the caller may modify their own handle's avatar (403)
//   - rate-limit: 429 with Retry-After when the per-minute bucket trips
//   - binary body: arrayBuffer-based read is forwarded to the service
//   - AvatarError → (code, status) mapping (400/403/404/413/503)
//   - DELETE semantics: 404 when no avatar existed, 200 + ok:true otherwise
//
// The service layer is mocked wholesale so we assert exactly what the
// route forwards. AvatarError is kept real so the error-mapping path
// exercises the actual constructor.

const setAgentAvatarMock = vi.fn()
const removeAgentAvatarMock = vi.fn()
const buildAvatarUrlMock = vi.fn((k: string | null) =>
  k ? `https://project.supabase.co/storage/v1/object/public/avatars/${k}` : null,
)
const checkAvatarWriteRateLimitMock = vi.fn()
const findAgentByIdMock = vi.fn()

// Unused-by-avatar service mocks: other routes in agents.ts (recover,
// rotate-key) import through the same module, so the mock has to satisfy
// the full import surface even when the avatar handlers don't call them.
// Value is `vi.fn()` — any accidental invocation fails the test loudly
// instead of silently talking to a real DB.
vi.mock('../src/services/agent.service.js', () => ({
  getAgent: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
  rotateApiKey: vi.fn(),
  AgentError: class AgentError extends Error {
    code: string
    status: number
    constructor(code: string, message: string, status: number) {
      super(message)
      this.code = code
      this.status = status
    }
  },
}))

vi.mock('../src/services/otp.service.js', () => ({
  claimOtpSendSlot: vi.fn(),
  releaseOtpSendSlot: vi.fn(),
  registerOtpVerifyAttempt: vi.fn(),
  clearOtpAttempts: vi.fn(),
  OtpRateError: class OtpRateError extends Error {
    code: string
    retryAfterSeconds?: number
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  },
}))

vi.mock('../src/middleware/rate-limit.js', () => ({
  ipRateLimit: () => createMiddleware(async (_c, next) => next()),
}))

vi.mock('../src/lib/redis.js', () => ({
  getRedis: () => ({
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    incr: vi.fn(),
    expire: vi.fn(),
  }),
}))

vi.mock('../src/lib/id.js', () => ({
  generateId: (prefix: string) => `${prefix}_test`,
}))

// env.js runs zod validation against process.env at import time — in the
// test process those secrets aren't set, so we stub the parsed env to the
// values the avatar service + route code expects. Mirrors how other route
// tests decouple from deployed config.
vi.mock('../src/env.js', () => ({
  env: {
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    AVATARS_BUCKET: 'avatars',
    ATTACHMENTS_BUCKET: 'attachments',
    UPSTASH_REDIS_REST_URL: 'https://redis.upstash.io',
    UPSTASH_REDIS_REST_TOKEN: 'test-token',
    PORT: 3000,
    NODE_ENV: 'test',
  },
}))

vi.mock('../src/services/avatar.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../src/services/avatar.service.js')
  >('../src/services/avatar.service.js')
  return {
    ...actual,
    setAgentAvatar: setAgentAvatarMock,
    removeAgentAvatar: removeAgentAvatarMock,
    buildAvatarUrl: buildAvatarUrlMock,
  }
})

vi.mock('../src/services/enforcement.service.js', () => ({
  checkAvatarWriteRateLimit: checkAvatarWriteRateLimitMock,
}))

vi.mock('@agentchat/db', () => ({
  findAgentById: findAgentByIdMock,
  findActiveAgentByEmail: vi.fn(),
  getSupabaseClient: () => ({
    auth: { signInWithOtp: vi.fn(), verifyOtp: vi.fn() },
    from: () => ({
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      select: () => ({
        eq: () => ({
          limit: () => ({ maybeSingle: () => ({ data: null }) }),
        }),
      }),
    }),
  }),
}))

// Default caller identity; tests can override before dispatching.
let currentAgentId = 'agt_alice'
vi.mock('../src/middleware/auth.js', () => ({
  authMiddleware: createMiddleware(async (c, next) => {
    c.set('agentId', currentAgentId)
    return next()
  }),
  authAnyStatusMiddleware: createMiddleware(async (c, next) => {
    c.set('agentId', currentAgentId)
    c.set('agent', { id: currentAgentId, handle: 'alice' })
    return next()
  }),
}))

const { agentRoutes } = await import('../src/routes/agents.js')
const { AvatarError, MAX_AVATAR_INPUT_BYTES } = await import(
  '../src/services/avatar.service.js'
)

function buildApp() {
  const app = new Hono()
  app.route('/v1/agents', agentRoutes)
  return app
}

function binaryRequest(
  method: 'PUT' | 'DELETE',
  path: string,
  body?: Buffer,
  headers?: Record<string, string>,
) {
  return new Request(`http://test.local${path}`, {
    method,
    headers: {
      'Content-Type': 'image/png',
      ...(headers ?? {}),
    },
    body: body ?? undefined,
  })
}

beforeEach(() => {
  setAgentAvatarMock.mockReset()
  removeAgentAvatarMock.mockReset()
  checkAvatarWriteRateLimitMock.mockReset()
  findAgentByIdMock.mockReset()
  currentAgentId = 'agt_alice'
  checkAvatarWriteRateLimitMock.mockResolvedValue({ allowed: true })
  findAgentByIdMock.mockResolvedValue({ id: 'agt_alice', handle: 'alice', status: 'active' })
})

// ─── PUT /v1/agents/:handle/avatar ────────────────────────────────────

describe('PUT /v1/agents/:handle/avatar', () => {
  it('reads the request body as a buffer and forwards to setAgentAvatar', async () => {
    setAgentAvatarMock.mockResolvedValue({
      avatar_key: 'agt_alice/abc.webp',
      avatar_url: 'https://project.supabase.co/storage/v1/object/public/avatars/agt_alice/abc.webp',
    })

    const body = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
    const res = await buildApp().fetch(binaryRequest('PUT', '/v1/agents/alice/avatar', body))

    expect(res.status).toBe(200)
    const json = (await res.json()) as { avatar_key: string; avatar_url: string }
    expect(json.avatar_key).toBe('agt_alice/abc.webp')

    expect(setAgentAvatarMock).toHaveBeenCalledTimes(1)
    const [id, passedBytes] = setAgentAvatarMock.mock.calls[0]!
    expect(id).toBe('agt_alice')
    expect(Buffer.isBuffer(passedBytes)).toBe(true)
    expect(passedBytes).toEqual(body)
  })

  it('strips a leading @ from the handle before the self-ownership check', async () => {
    setAgentAvatarMock.mockResolvedValue({
      avatar_key: 'agt_alice/abc.webp',
      avatar_url: 'https://project.supabase.co/storage/v1/object/public/avatars/agt_alice/abc.webp',
    })

    const body = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const res = await buildApp().fetch(binaryRequest('PUT', '/v1/agents/@alice/avatar', body))

    expect(res.status).toBe(200)
  })

  it('returns 403 FORBIDDEN when the caller is not the handle owner', async () => {
    const body = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const res = await buildApp().fetch(binaryRequest('PUT', '/v1/agents/bob/avatar', body))

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'FORBIDDEN' })
    expect(setAgentAvatarMock).not.toHaveBeenCalled()
  })

  it('returns 403 when findAgentById returns null (deleted/unknown caller agent id)', async () => {
    findAgentByIdMock.mockResolvedValue(null)
    const body = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const res = await buildApp().fetch(binaryRequest('PUT', '/v1/agents/alice/avatar', body))

    expect(res.status).toBe(403)
    expect(setAgentAvatarMock).not.toHaveBeenCalled()
  })

  it('returns 429 RATE_LIMITED with retry_after_ms when the bucket trips', async () => {
    checkAvatarWriteRateLimitMock.mockResolvedValue({ allowed: false, retryAfterMs: 42_000 })

    const body = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const res = await buildApp().fetch(binaryRequest('PUT', '/v1/agents/alice/avatar', body))

    expect(res.status).toBe(429)
    const json = (await res.json()) as { code: string; retry_after_ms: number }
    expect(json).toMatchObject({ code: 'RATE_LIMITED', retry_after_ms: 42_000 })
    expect(res.headers.get('retry-after')).toBe('42')
    expect(setAgentAvatarMock).not.toHaveBeenCalled()
  })

  it('maps AvatarError{code,status} to the matching HTTP response', async () => {
    setAgentAvatarMock.mockRejectedValue(
      new AvatarError('UNSUPPORTED_FORMAT', 'not an image', 400),
    )

    const body = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    const res = await buildApp().fetch(binaryRequest('PUT', '/v1/agents/alice/avatar', body))

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      code: 'UNSUPPORTED_FORMAT',
      message: 'not an image',
    })
  })

  it('maps AvatarError STORAGE_UNAVAILABLE to 503', async () => {
    setAgentAvatarMock.mockRejectedValue(
      new AvatarError('STORAGE_UNAVAILABLE', 'storage down', 503),
    )

    const body = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const res = await buildApp().fetch(binaryRequest('PUT', '/v1/agents/alice/avatar', body))

    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ code: 'STORAGE_UNAVAILABLE' })
  })

  it('maps AvatarError PAYLOAD_TOO_LARGE to 413', async () => {
    setAgentAvatarMock.mockRejectedValue(
      new AvatarError('PAYLOAD_TOO_LARGE', 'too big', 413),
    )
    const body = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const res = await buildApp().fetch(binaryRequest('PUT', '/v1/agents/alice/avatar', body))
    expect(res.status).toBe(413)
  })

  it('rethrows non-AvatarError exceptions as 500', async () => {
    setAgentAvatarMock.mockRejectedValue(new Error('unexpected database outage'))

    const body = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const res = await buildApp().fetch(binaryRequest('PUT', '/v1/agents/alice/avatar', body))

    expect(res.status).toBe(500)
  })

  // Surface-level sanity check for the max-size constant. The bodyLimit
  // middleware refuses to hand the body to the handler past this cap.
  // We don't actually materialize the 5 MB buffer here (that's what the
  // service test does); just pin that the constant is the expected value.
  it('MAX_AVATAR_INPUT_BYTES is 5 MB', () => {
    expect(MAX_AVATAR_INPUT_BYTES).toBe(5 * 1024 * 1024)
  })
})

// ─── DELETE /v1/agents/:handle/avatar ─────────────────────────────────

describe('DELETE /v1/agents/:handle/avatar', () => {
  it('returns 200 + ok:true on a successful remove', async () => {
    removeAgentAvatarMock.mockResolvedValue({ existed: true })

    const res = await buildApp().fetch(
      new Request('http://test.local/v1/agents/alice/avatar', { method: 'DELETE' }),
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })
    expect(removeAgentAvatarMock).toHaveBeenCalledWith('agt_alice')
  })

  it('returns 404 when the agent had no avatar set', async () => {
    removeAgentAvatarMock.mockResolvedValue({ existed: false })

    const res = await buildApp().fetch(
      new Request('http://test.local/v1/agents/alice/avatar', { method: 'DELETE' }),
    )

    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ code: 'NOT_FOUND' })
  })

  it('returns 403 when the caller is not the handle owner', async () => {
    const res = await buildApp().fetch(
      new Request('http://test.local/v1/agents/bob/avatar', { method: 'DELETE' }),
    )

    expect(res.status).toBe(403)
    expect(removeAgentAvatarMock).not.toHaveBeenCalled()
  })

  it('applies the rate limit to DELETE the same as PUT', async () => {
    checkAvatarWriteRateLimitMock.mockResolvedValue({ allowed: false, retryAfterMs: 5_000 })

    const res = await buildApp().fetch(
      new Request('http://test.local/v1/agents/alice/avatar', { method: 'DELETE' }),
    )

    expect(res.status).toBe(429)
    expect(removeAgentAvatarMock).not.toHaveBeenCalled()
  })

  it('maps AvatarError{code,status} on remove to HTTP', async () => {
    removeAgentAvatarMock.mockRejectedValue(
      new AvatarError('INTERNAL_ERROR', 'db dead', 500),
    )

    const res = await buildApp().fetch(
      new Request('http://test.local/v1/agents/alice/avatar', { method: 'DELETE' }),
    )

    expect(res.status).toBe(500)
  })
})
