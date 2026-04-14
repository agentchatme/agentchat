import { describe, it, expect, vi, beforeEach } from 'vitest'

// Full-pause enforcement for the /v1/messages/sync and /sync/ack
// endpoints. Chunk 1c added `paused_by_owner = 'full'` suppression to
// the WS drain path in handler.ts; chunk 1c-follow-up extended the
// same silent-no-op to the HTTP sync/ack surface so a full-paused
// agent cannot sidestep the drain by polling the REST endpoint. See
// plan §11.3 and the routes/messages.ts comments.
//
// These tests:
//   - Replace authMiddleware with a controllable shim that sets the
//     agent on the Hono context. The shim reads from a vi.hoisted()
//     object so each test can flip paused_by_owner without reimporting.
//   - Stub message.service exports as spies so we can assert they
//     WERE NOT CALLED when paused — silent no-op, not error.
//   - Fetch the real messageRoutes Hono app, preserving the actual
//     route wiring in routes/messages.ts (not a re-implementation).

const state = vi.hoisted(() => ({
  agent: {
    id: 'agt_test',
    handle: 'tester',
    display_name: null,
    status: 'active' as 'active' | 'suspended' | 'deleted' | 'restricted',
    paused_by_owner: 'none' as 'none' | 'send' | 'full',
  },
}))

vi.mock('../src/middleware/auth.js', async () => {
  const { createMiddleware } = await import('hono/factory')
  const passThrough = createMiddleware(async (c, next) => {
    c.set('agentId', state.agent.id)
    c.set('agent', state.agent)
    return next()
  })
  return { authMiddleware: passThrough, authAnyStatusMiddleware: passThrough }
})

vi.mock('../src/middleware/idempotency.js', async () => {
  const { createMiddleware } = await import('hono/factory')
  return {
    idempotencyMiddleware: createMiddleware(async (_c, next) => next()),
  }
})

const sendMessageMock = vi.fn()
const getMessagesMock = vi.fn()
const markAsReadMock = vi.fn()
const syncUndeliveredMock = vi.fn()
const ackDeliveredMock = vi.fn()
const hideMessageForMeMock = vi.fn()

// MessageError used for throw paths; re-export a harmless shim since
// these sync/ack tests never hit the error branches.
class MessageErrorShim extends Error {
  code: string
  status: number
  constructor(code: string, message: string, status: number) {
    super(message)
    this.code = code
    this.status = status
  }
}

vi.mock('../src/services/message.service.js', () => ({
  sendMessage: sendMessageMock,
  getMessages: getMessagesMock,
  markAsRead: markAsReadMock,
  syncUndelivered: syncUndeliveredMock,
  ackDelivered: ackDeliveredMock,
  hideMessageForMe: hideMessageForMeMock,
  MessageError: MessageErrorShim,
}))

const { messageRoutes } = await import('../src/routes/messages.js')

function syncReq(after?: string) {
  const url = after
    ? `http://test.local/sync?after=${encodeURIComponent(after)}`
    : 'http://test.local/sync'
  return new Request(url, { method: 'GET' })
}

function ackReq(body: unknown) {
  return new Request('http://test.local/sync/ack', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('GET /v1/messages/sync — full-pause suppression', () => {
  beforeEach(() => {
    syncUndeliveredMock.mockReset()
    ackDeliveredMock.mockReset()
    state.agent.paused_by_owner = 'none'
  })

  it('returns [] and skips syncUndelivered when paused_by_owner=full', async () => {
    state.agent.paused_by_owner = 'full'
    const res = await messageRoutes.fetch(syncReq())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
    expect(syncUndeliveredMock).not.toHaveBeenCalled()
  })

  it('passes through to syncUndelivered when paused_by_owner=none', async () => {
    syncUndeliveredMock.mockResolvedValue([{ id: 'msg_1', seq: 1 }])
    const res = await messageRoutes.fetch(syncReq())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ id: 'msg_1', seq: 1 }])
    expect(syncUndeliveredMock).toHaveBeenCalledTimes(1)
  })

  it('passes through to syncUndelivered when paused_by_owner=send (send-only pause)', async () => {
    // Send-only pause freezes only outbound; inbound/sync must still work.
    state.agent.paused_by_owner = 'send'
    syncUndeliveredMock.mockResolvedValue([{ id: 'msg_2', seq: 2 }])
    const res = await messageRoutes.fetch(syncReq())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ id: 'msg_2', seq: 2 }])
    expect(syncUndeliveredMock).toHaveBeenCalledTimes(1)
  })

  it('forwards the after cursor to syncUndelivered when set', async () => {
    syncUndeliveredMock.mockResolvedValue([])
    await messageRoutes.fetch(syncReq('mdl_cursor_123'))
    expect(syncUndeliveredMock).toHaveBeenCalledWith('agt_test', {
      after: 'mdl_cursor_123',
      limit: undefined,
    })
  })
})

describe('POST /v1/messages/sync/ack — full-pause suppression', () => {
  beforeEach(() => {
    syncUndeliveredMock.mockReset()
    ackDeliveredMock.mockReset()
    state.agent.paused_by_owner = 'none'
  })

  it('returns {acked:0} and skips ackDelivered when paused_by_owner=full', async () => {
    state.agent.paused_by_owner = 'full'
    const res = await messageRoutes.fetch(ackReq({ last_delivery_id: 'mdl_1' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ acked: 0 })
    expect(ackDeliveredMock).not.toHaveBeenCalled()
  })

  it('short-circuits BEFORE JSON body validation when full-paused', async () => {
    // Proves the guard runs first — without it, a malformed body would
    // surface VALIDATION_ERROR, letting a pause-aware client detect
    // that pausing is in effect by probing with garbage.
    state.agent.paused_by_owner = 'full'
    const res = await messageRoutes.fetch(
      new Request('http://test.local/sync/ack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not json',
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ acked: 0 })
  })

  it('passes through to ackDelivered when paused_by_owner=none', async () => {
    ackDeliveredMock.mockResolvedValue(5)
    const res = await messageRoutes.fetch(ackReq({ last_delivery_id: 'mdl_99' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ acked: 5 })
    expect(ackDeliveredMock).toHaveBeenCalledWith('agt_test', 'mdl_99')
  })

  it('passes through to ackDelivered when paused_by_owner=send', async () => {
    state.agent.paused_by_owner = 'send'
    ackDeliveredMock.mockResolvedValue(3)
    const res = await messageRoutes.fetch(ackReq({ last_delivery_id: 'mdl_50' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ acked: 3 })
    expect(ackDeliveredMock).toHaveBeenCalledWith('agt_test', 'mdl_50')
  })

  it('rejects missing last_delivery_id with 400 VALIDATION_ERROR when NOT paused', async () => {
    // Regression guard: the full-pause early-return must not swallow
    // the normal validation path. A non-paused agent still needs the
    // 400 when it omits last_delivery_id.
    const res = await messageRoutes.fetch(ackReq({}))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('VALIDATION_ERROR')
    expect(ackDeliveredMock).not.toHaveBeenCalled()
  })
})
