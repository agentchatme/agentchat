import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'

// HTTP-surface tests for the mute routes. The service and DB layers have
// their own unit tests — here we're pinning the route's translation job:
//
//   - body parsing / shape validation
//   - handle → service input mapping (kind=agent accepts handle OR id)
//   - MuteError → (code, status) response mapping
//   - rate-limit guard wiring (429 + retry_after_ms)
//
// The mute service is mocked wholesale so each test can assert exactly
// what the route passed to it, and control the error shape it gets back.

const createMuteForAgentMock = vi.fn()
const removeMuteForAgentMock = vi.fn()
const listMutesForAgentMock = vi.fn()
const getMuteForAgentMock = vi.fn()
const findAgentByHandleMock = vi.fn()
const checkMuteWriteRateLimitMock = vi.fn()

vi.mock('../src/services/mute.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../src/services/mute.service.js')
  >('../src/services/mute.service.js')
  return {
    ...actual,
    createMuteForAgent: createMuteForAgentMock,
    removeMuteForAgent: removeMuteForAgentMock,
    listMutesForAgent: listMutesForAgentMock,
    getMuteForAgent: getMuteForAgentMock,
  }
})

vi.mock('@agentchat/db', () => ({
  findAgentByHandle: findAgentByHandleMock,
}))

vi.mock('../src/services/enforcement.service.js', () => ({
  checkMuteWriteRateLimit: checkMuteWriteRateLimitMock,
}))

// Swap the real auth middleware for a no-op that just stamps agentId.
// The default is agt_alice; tests can override via overrideAgentId.
let currentAgentId = 'agt_alice'
vi.mock('../src/middleware/auth.js', () => ({
  authMiddleware: createMiddleware(async (c, next) => {
    c.set('agentId', currentAgentId)
    return next()
  }),
}))

const { muteRoutes } = await import('../src/routes/mutes.js')
const { MuteError } = await import('../src/services/mute.service.js')

function buildApp() {
  const app = new Hono()
  app.route('/v1/mutes', muteRoutes)
  return app
}

function jsonRequest(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
) {
  return new Request(`http://test.local${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

beforeEach(() => {
  createMuteForAgentMock.mockReset()
  removeMuteForAgentMock.mockReset()
  listMutesForAgentMock.mockReset()
  getMuteForAgentMock.mockReset()
  findAgentByHandleMock.mockReset()
  checkMuteWriteRateLimitMock.mockReset()
  currentAgentId = 'agt_alice'
  // Default: rate limiter permits the write. Individual tests flip this.
  checkMuteWriteRateLimitMock.mockResolvedValue({ allowed: true })
})

describe('POST /v1/mutes', () => {
  it('resolves target_handle → agent id and forwards to the service', async () => {
    findAgentByHandleMock.mockResolvedValue({ id: 'agt_bob', handle: 'bob' })
    createMuteForAgentMock.mockResolvedValue({
      muter_agent_id: 'agt_alice',
      target_kind: 'agent',
      target_id: 'agt_bob',
      muted_until: null,
      created_at: '2026-04-18T00:00:00Z',
    })

    const res = await buildApp().fetch(
      jsonRequest('POST', '/v1/mutes', {
        target_kind: 'agent',
        target_handle: '@Bob',
      }),
    )

    expect(res.status).toBe(201)
    expect(findAgentByHandleMock).toHaveBeenCalledWith('bob')
    expect(createMuteForAgentMock).toHaveBeenCalledWith({
      muterAgentId: 'agt_alice',
      targetKind: 'agent',
      targetId: 'agt_bob',
      mutedUntil: null,
    })
  })

  it('accepts target_id directly for agent kind (fallback path)', async () => {
    createMuteForAgentMock.mockResolvedValue({
      muter_agent_id: 'agt_alice',
      target_kind: 'agent',
      target_id: 'agt_bob',
      muted_until: null,
      created_at: '2026-04-18T00:00:00Z',
    })

    const res = await buildApp().fetch(
      jsonRequest('POST', '/v1/mutes', {
        target_kind: 'agent',
        target_id: 'agt_bob',
      }),
    )

    expect(res.status).toBe(201)
    // The fallback path skips the handle lookup entirely.
    expect(findAgentByHandleMock).not.toHaveBeenCalled()
  })

  it('forwards muted_until verbatim to the service', async () => {
    findAgentByHandleMock.mockResolvedValue({ id: 'agt_bob', handle: 'bob' })
    createMuteForAgentMock.mockResolvedValue({
      muter_agent_id: 'agt_alice',
      target_kind: 'agent',
      target_id: 'agt_bob',
      muted_until: '2030-01-01T00:00:00Z',
      created_at: '2026-04-18T00:00:00Z',
    })
    const res = await buildApp().fetch(
      jsonRequest('POST', '/v1/mutes', {
        target_kind: 'agent',
        target_handle: 'bob',
        muted_until: '2030-01-01T00:00:00Z',
      }),
    )
    expect(res.status).toBe(201)
    expect(createMuteForAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ mutedUntil: '2030-01-01T00:00:00Z' }),
    )
  })

  it('returns 400 on invalid JSON body', async () => {
    const res = await buildApp().fetch(
      new Request('http://test.local/v1/mutes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not-json',
      }),
    )
    expect(res.status).toBe(400)
    const err = await res.json()
    expect(err.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 when target_kind is missing', async () => {
    const res = await buildApp().fetch(
      jsonRequest('POST', '/v1/mutes', { target_handle: 'bob' }),
    )
    expect(res.status).toBe(400)
    const err = await res.json()
    expect(err.code).toBe('VALIDATION_ERROR')
    expect(createMuteForAgentMock).not.toHaveBeenCalled()
  })

  it('returns 400 when target_kind is an unknown value', async () => {
    const res = await buildApp().fetch(
      jsonRequest('POST', '/v1/mutes', {
        target_kind: 'owner',
        target_id: 'x',
      }),
    )
    expect(res.status).toBe(400)
    const err = await res.json()
    expect(err.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 when muted_until is not a string/null', async () => {
    const res = await buildApp().fetch(
      jsonRequest('POST', '/v1/mutes', {
        target_kind: 'agent',
        target_handle: 'bob',
        muted_until: 3600,
      }),
    )
    expect(res.status).toBe(400)
    const err = await res.json()
    expect(err.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 when agent kind is missing both handle and id', async () => {
    const res = await buildApp().fetch(
      jsonRequest('POST', '/v1/mutes', { target_kind: 'agent' }),
    )
    expect(res.status).toBe(400)
    const err = await res.json()
    expect(err.message).toMatch(/target_handle or target_id/)
  })

  it('returns 400 when conversation kind is missing target_id', async () => {
    const res = await buildApp().fetch(
      jsonRequest('POST', '/v1/mutes', { target_kind: 'conversation' }),
    )
    expect(res.status).toBe(400)
    const err = await res.json()
    expect(err.message).toMatch(/target_id is required/)
  })

  it('returns 404 when the handle is unknown', async () => {
    findAgentByHandleMock.mockResolvedValue(null)
    const res = await buildApp().fetch(
      jsonRequest('POST', '/v1/mutes', {
        target_kind: 'agent',
        target_handle: 'ghost',
      }),
    )
    expect(res.status).toBe(404)
    const err = await res.json()
    expect(err.code).toBe('AGENT_NOT_FOUND')
    expect(createMuteForAgentMock).not.toHaveBeenCalled()
  })

  it('maps service MuteError to its (code, status)', async () => {
    findAgentByHandleMock.mockResolvedValue({ id: 'agt_bob', handle: 'bob' })
    createMuteForAgentMock.mockRejectedValue(
      new MuteError('SELF_MUTE', 'Cannot mute yourself', 400),
    )
    const res = await buildApp().fetch(
      jsonRequest('POST', '/v1/mutes', {
        target_kind: 'agent',
        target_handle: 'bob',
      }),
    )
    expect(res.status).toBe(400)
    const err = await res.json()
    expect(err.code).toBe('SELF_MUTE')
  })

  it('returns 429 + retry_after_ms when the rate limit trips', async () => {
    checkMuteWriteRateLimitMock.mockResolvedValueOnce({
      allowed: false,
      retryAfterMs: 420,
    })
    const res = await buildApp().fetch(
      jsonRequest('POST', '/v1/mutes', {
        target_kind: 'agent',
        target_handle: 'bob',
      }),
    )
    expect(res.status).toBe(429)
    const err = await res.json()
    expect(err.code).toBe('RATE_LIMITED')
    expect(err.retry_after_ms).toBe(420)
    // Guard fires *before* body parsing and service dispatch.
    expect(createMuteForAgentMock).not.toHaveBeenCalled()
    expect(findAgentByHandleMock).not.toHaveBeenCalled()
  })
})

describe('GET /v1/mutes', () => {
  it('returns the caller’s active mutes', async () => {
    listMutesForAgentMock.mockResolvedValue([
      {
        muter_agent_id: 'agt_alice',
        target_kind: 'agent',
        target_id: 'agt_bob',
        muted_until: null,
        created_at: '2026-04-18T00:00:00Z',
      },
    ])
    const res = await buildApp().fetch(new Request('http://test.local/v1/mutes'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.mutes).toHaveLength(1)
    expect(listMutesForAgentMock).toHaveBeenCalledWith('agt_alice', {})
  })

  it('forwards a ?kind= filter to the service', async () => {
    listMutesForAgentMock.mockResolvedValue([])
    const res = await buildApp().fetch(
      new Request('http://test.local/v1/mutes?kind=conversation'),
    )
    expect(res.status).toBe(200)
    expect(listMutesForAgentMock).toHaveBeenCalledWith('agt_alice', {
      kind: 'conversation',
    })
  })

  it('maps MuteError from the service (e.g. invalid kind filter)', async () => {
    listMutesForAgentMock.mockRejectedValue(
      new MuteError('VALIDATION_ERROR', 'bad kind', 400),
    )
    const res = await buildApp().fetch(
      new Request('http://test.local/v1/mutes?kind=owner'),
    )
    expect(res.status).toBe(400)
  })

  it('does not consume rate-limit tokens (GETs are on the global budget)', async () => {
    listMutesForAgentMock.mockResolvedValue([])
    await buildApp().fetch(new Request('http://test.local/v1/mutes'))
    expect(checkMuteWriteRateLimitMock).not.toHaveBeenCalled()
  })
})

describe('GET /v1/mutes/agent/:handle', () => {
  it('returns the mute row when active', async () => {
    findAgentByHandleMock.mockResolvedValue({ id: 'agt_bob', handle: 'bob' })
    getMuteForAgentMock.mockResolvedValue({
      muter_agent_id: 'agt_alice',
      target_kind: 'agent',
      target_id: 'agt_bob',
      muted_until: null,
      created_at: '2026-04-18T00:00:00Z',
    })
    const res = await buildApp().fetch(
      new Request('http://test.local/v1/mutes/agent/bob'),
    )
    expect(res.status).toBe(200)
    expect(getMuteForAgentMock).toHaveBeenCalledWith(
      'agt_alice',
      'agent',
      'agt_bob',
    )
  })

  it('returns 404 when no active mute exists', async () => {
    findAgentByHandleMock.mockResolvedValue({ id: 'agt_bob', handle: 'bob' })
    getMuteForAgentMock.mockResolvedValue(null)
    const res = await buildApp().fetch(
      new Request('http://test.local/v1/mutes/agent/bob'),
    )
    expect(res.status).toBe(404)
    const err = await res.json()
    expect(err.code).toBe('NOT_FOUND')
  })

  it('returns 404 when the handle itself is unknown', async () => {
    findAgentByHandleMock.mockResolvedValue(null)
    const res = await buildApp().fetch(
      new Request('http://test.local/v1/mutes/agent/ghost'),
    )
    expect(res.status).toBe(404)
    const err = await res.json()
    expect(err.code).toBe('AGENT_NOT_FOUND')
    expect(getMuteForAgentMock).not.toHaveBeenCalled()
  })
})

describe('GET /v1/mutes/conversation/:id', () => {
  it('returns 200 when the conversation is muted', async () => {
    getMuteForAgentMock.mockResolvedValue({
      muter_agent_id: 'agt_alice',
      target_kind: 'conversation',
      target_id: 'conv_xyz',
      muted_until: null,
      created_at: '2026-04-18T00:00:00Z',
    })
    const res = await buildApp().fetch(
      new Request('http://test.local/v1/mutes/conversation/conv_xyz'),
    )
    expect(res.status).toBe(200)
  })

  it('returns 404 when not muted', async () => {
    getMuteForAgentMock.mockResolvedValue(null)
    const res = await buildApp().fetch(
      new Request('http://test.local/v1/mutes/conversation/conv_xyz'),
    )
    expect(res.status).toBe(404)
  })
})

describe('DELETE /v1/mutes/agent/:handle', () => {
  it('resolves the handle and calls removeMute', async () => {
    findAgentByHandleMock.mockResolvedValue({ id: 'agt_bob', handle: 'bob' })
    removeMuteForAgentMock.mockResolvedValue(undefined)
    const res = await buildApp().fetch(
      new Request('http://test.local/v1/mutes/agent/bob', { method: 'DELETE' }),
    )
    expect(res.status).toBe(200)
    expect(removeMuteForAgentMock).toHaveBeenCalledWith({
      muterAgentId: 'agt_alice',
      targetKind: 'agent',
      targetId: 'agt_bob',
    })
  })

  it('returns 404 when no active mute existed', async () => {
    findAgentByHandleMock.mockResolvedValue({ id: 'agt_bob', handle: 'bob' })
    removeMuteForAgentMock.mockRejectedValue(
      new MuteError('NOT_FOUND', 'No active mute found for that target', 404),
    )
    const res = await buildApp().fetch(
      new Request('http://test.local/v1/mutes/agent/bob', { method: 'DELETE' }),
    )
    expect(res.status).toBe(404)
    const err = await res.json()
    expect(err.code).toBe('NOT_FOUND')
  })

  it('returns 429 when the rate limit trips', async () => {
    checkMuteWriteRateLimitMock.mockResolvedValueOnce({
      allowed: false,
      retryAfterMs: 300,
    })
    const res = await buildApp().fetch(
      new Request('http://test.local/v1/mutes/agent/bob', { method: 'DELETE' }),
    )
    expect(res.status).toBe(429)
    expect(findAgentByHandleMock).not.toHaveBeenCalled()
    expect(removeMuteForAgentMock).not.toHaveBeenCalled()
  })
})

describe('DELETE /v1/mutes/conversation/:id', () => {
  it('calls removeMute with kind=conversation', async () => {
    removeMuteForAgentMock.mockResolvedValue(undefined)
    const res = await buildApp().fetch(
      new Request('http://test.local/v1/mutes/conversation/conv_xyz', {
        method: 'DELETE',
      }),
    )
    expect(res.status).toBe(200)
    expect(removeMuteForAgentMock).toHaveBeenCalledWith({
      muterAgentId: 'agt_alice',
      targetKind: 'conversation',
      targetId: 'conv_xyz',
    })
  })

  it('returns 429 when the rate limit trips', async () => {
    checkMuteWriteRateLimitMock.mockResolvedValueOnce({
      allowed: false,
      retryAfterMs: 100,
    })
    const res = await buildApp().fetch(
      new Request('http://test.local/v1/mutes/conversation/conv_xyz', {
        method: 'DELETE',
      }),
    )
    expect(res.status).toBe(429)
    expect(removeMuteForAgentMock).not.toHaveBeenCalled()
  })
})
