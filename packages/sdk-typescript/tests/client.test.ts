import { describe, it, expect, vi } from 'vitest'
import { AgentChatClient } from '../src/client.js'

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

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })

describe('AgentChatClient.sendMessage', () => {
  it('auto-generates client_msg_id when omitted', async () => {
    let receivedBody: { client_msg_id: string } | null = null
    const fetch = scriptedFetch([
      (_, init) => {
        receivedBody = JSON.parse(init!.body as string)
        return json(201, {
          id: 'msg_1',
          conversation_id: 'conv_1',
          sender: 'me',
          client_msg_id: receivedBody!.client_msg_id,
          seq: 1,
          type: 'text',
          content: { text: 'hi' },
          metadata: {},
          status: 'stored',
          created_at: '2026-01-01T00:00:00Z',
          delivered_at: null,
          read_at: null,
        })
      },
    ])
    const client = new AgentChatClient({ apiKey: 'k', baseUrl: 'https://api.test', fetch })
    await client.sendMessage({ to: '@alice', content: { text: 'hi' } })
    expect(receivedBody).toBeTruthy()
    expect(receivedBody!.client_msg_id).toMatch(/.+/)
  })

  it('parses X-Backlog-Warning header', async () => {
    const fetch = scriptedFetch([
      json(
        201,
        {
          id: 'msg_1',
          conversation_id: 'conv_1',
          sender: 'me',
          client_msg_id: 'abc',
          seq: 1,
          type: 'text',
          content: { text: 'hi' },
          metadata: {},
          status: 'stored',
          created_at: '2026-01-01T00:00:00Z',
          delivered_at: null,
          read_at: null,
        },
        { 'X-Backlog-Warning': 'alice=6000' },
      ),
    ])
    const onBacklogWarning = vi.fn()
    const client = new AgentChatClient({
      apiKey: 'k',
      baseUrl: 'https://api.test',
      fetch,
      onBacklogWarning,
    })
    const res = await client.sendMessage({
      to: '@alice',
      content: { text: 'hi' },
      client_msg_id: 'abc',
    })
    expect(res.backlogWarning).toEqual({ recipientHandle: 'alice', undeliveredCount: 6000 })
    expect(onBacklogWarning).toHaveBeenCalledWith({ recipientHandle: 'alice', undeliveredCount: 6000 })
  })

  it('ignores malformed X-Backlog-Warning', async () => {
    const fetch = scriptedFetch([
      json(
        201,
        {
          id: 'msg_1',
          conversation_id: 'conv_1',
          sender: 'me',
          client_msg_id: 'abc',
          seq: 1,
          type: 'text',
          content: { text: 'hi' },
          metadata: {},
          status: 'stored',
          created_at: '2026-01-01T00:00:00Z',
          delivered_at: null,
          read_at: null,
        },
        { 'X-Backlog-Warning': 'not-valid' },
      ),
    ])
    const client = new AgentChatClient({ apiKey: 'k', baseUrl: 'https://api.test', fetch })
    const res = await client.sendMessage({
      to: '@alice',
      content: { text: 'hi' },
      client_msg_id: 'abc',
    })
    expect(res.backlogWarning).toBeNull()
  })

  it('sendMessage is auto-retried on 5xx (server dedupes via client_msg_id)', async () => {
    let attempts = 0
    const fetch = scriptedFetch([
      () => {
        attempts++
        return json(503, { code: 'INTERNAL_ERROR', message: 'try later' })
      },
      () => {
        attempts++
        return json(200, {
          id: 'msg_1',
          conversation_id: 'conv_1',
          sender: 'me',
          client_msg_id: 'abc',
          seq: 1,
          type: 'text',
          content: { text: 'hi' },
          metadata: {},
          status: 'stored',
          created_at: '2026-01-01T00:00:00Z',
          delivered_at: null,
          read_at: null,
        })
      },
    ])
    const client = new AgentChatClient({
      apiKey: 'k',
      baseUrl: 'https://api.test',
      fetch,
      retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 },
    })
    const res = await client.sendMessage({
      to: '@alice',
      content: { text: 'hi' },
      client_msg_id: 'abc',
    })
    expect(res.message.id).toBe('msg_1')
    expect(attempts).toBe(2)
  })

  it('Authorization header is attached with the api key', async () => {
    let authHeader = ''
    const fetch = scriptedFetch([
      (_, init) => {
        const h = new Headers(init!.headers as HeadersInit)
        authHeader = h.get('authorization') ?? ''
        return json(200, [])
      },
    ])
    const client = new AgentChatClient({ apiKey: 'sk_123', baseUrl: 'https://api.test', fetch })
    await client.listConversations()
    expect(authHeader).toBe('Bearer sk_123')
  })
})

describe('AgentChatClient paginators', () => {
  it('contacts() iterates across pages', async () => {
    const total = 4
    const fetch = scriptedFetch([
      (input) => {
        const url = new URL(String(input))
        const offset = Number(url.searchParams.get('offset') ?? 0)
        const limit = Number(url.searchParams.get('limit') ?? 2)
        const items = Array.from({ length: Math.min(limit, total - offset) }, (_, i) => ({
          handle: `c${offset + i}`,
          display_name: null,
          description: null,
          notes: null,
          added_at: '2026-01-01T00:00:00Z',
        }))
        return json(200, { contacts: items, total, limit, offset })
      },
      (input) => {
        const url = new URL(String(input))
        const offset = Number(url.searchParams.get('offset') ?? 0)
        const limit = Number(url.searchParams.get('limit') ?? 2)
        const items = Array.from({ length: Math.min(limit, total - offset) }, (_, i) => ({
          handle: `c${offset + i}`,
          display_name: null,
          description: null,
          notes: null,
          added_at: '2026-01-01T00:00:00Z',
        }))
        return json(200, { contacts: items, total, limit, offset })
      },
    ])
    const client = new AgentChatClient({ apiKey: 'k', baseUrl: 'https://api.test', fetch })
    const handles: string[] = []
    for await (const c of client.contacts({ pageSize: 2 })) {
      handles.push(c.handle)
    }
    expect(handles).toEqual(['c0', 'c1', 'c2', 'c3'])
  })
})

describe('AgentChatClient.getMe', () => {
  it('fetches the caller\'s own full agent record from /v1/agents/me', async () => {
    let calledUrl = ''
    const fetch = scriptedFetch([
      (input) => {
        calledUrl = typeof input === 'string' ? input : input.toString()
        return json(200, {
          id: 'agt_self',
          handle: 'alice',
          email: 'alice@example.com',
          display_name: 'Alice',
          description: null,
          avatar_url: null,
          status: 'active',
          paused_by_owner: 'none',
          settings: {
            inbox_mode: 'open',
            group_invite_policy: 'open',
            discoverable: true,
          },
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        })
      },
    ])
    const client = new AgentChatClient({ apiKey: 'k', baseUrl: 'https://api.test', fetch })
    const me = await client.getMe()
    expect(calledUrl).toBe('https://api.test/v1/agents/me')
    expect(me.handle).toBe('alice')
    expect(me.status).toBe('active')
    expect(me.settings.inbox_mode).toBe('open')
  })
})

describe('AgentChatClient.markAsRead', () => {
  it('POSTs /v1/messages/:id/read with no body', async () => {
    let capturedMethod = ''
    let capturedUrl = ''
    let capturedBody: string | null = null
    const fetch = scriptedFetch([
      (input, init) => {
        capturedMethod = init?.method ?? ''
        capturedUrl = typeof input === 'string' ? input : input.toString()
        capturedBody = (init?.body as string | null) ?? null
        return json(200, { ok: true })
      },
    ])
    const client = new AgentChatClient({ apiKey: 'k', baseUrl: 'https://api.test', fetch })
    const res = await client.markAsRead('msg_123')
    expect(capturedMethod).toBe('POST')
    expect(capturedUrl).toBe('https://api.test/v1/messages/msg_123/read')
    expect(capturedBody == null || capturedBody === '').toBe(true)
    expect(res.ok).toBe(true)
  })
})

describe('AgentChatClient.hideConversation', () => {
  it('DELETEs /v1/conversations/:id to hide from the caller\'s inbox', async () => {
    let capturedMethod = ''
    let capturedUrl = ''
    const fetch = scriptedFetch([
      (input, init) => {
        capturedMethod = init?.method ?? ''
        capturedUrl = typeof input === 'string' ? input : input.toString()
        return json(200, { ok: true })
      },
    ])
    const client = new AgentChatClient({ apiKey: 'k', baseUrl: 'https://api.test', fetch })
    const res = await client.hideConversation('conv_abc')
    expect(capturedMethod).toBe('DELETE')
    expect(capturedUrl).toBe('https://api.test/v1/conversations/conv_abc')
    expect(res.ok).toBe(true)
  })
})

describe('AgentChatClient.getConversationParticipants', () => {
  it('GETs /v1/conversations/:id/participants and returns the array', async () => {
    let capturedUrl = ''
    const fetch = scriptedFetch([
      (input) => {
        capturedUrl = typeof input === 'string' ? input : input.toString()
        return json(200, [
          { handle: 'alice', display_name: 'Alice' },
          { handle: 'bob', display_name: null },
        ])
      },
    ])
    const client = new AgentChatClient({ apiKey: 'k', baseUrl: 'https://api.test', fetch })
    const res = await client.getConversationParticipants('conv_xyz')
    expect(capturedUrl).toBe('https://api.test/v1/conversations/conv_xyz/participants')
    expect(res).toHaveLength(2)
    expect(res[0].handle).toBe('alice')
    expect(res[1].display_name).toBeNull()
  })
})

describe('AgentChatClient.setGroupAvatar / removeGroupAvatar', () => {
  it('PUTs raw image bytes to /v1/groups/:id/avatar with honored contentType', async () => {
    let capturedMethod = ''
    let capturedUrl = ''
    let capturedContentType = ''
    const fetch = scriptedFetch([
      (input, init) => {
        capturedMethod = init?.method ?? ''
        capturedUrl = typeof input === 'string' ? input : input.toString()
        const headers = new Headers(init?.headers)
        capturedContentType = headers.get('content-type') ?? ''
        return json(200, { avatar_key: 'abc123', avatar_url: 'https://cdn/abc123.webp' })
      },
    ])
    const client = new AgentChatClient({ apiKey: 'k', baseUrl: 'https://api.test', fetch })
    const bytes = new Uint8Array([1, 2, 3, 4])
    const res = await client.setGroupAvatar('grp_1', bytes, { contentType: 'image/png' })
    expect(capturedMethod).toBe('PUT')
    expect(capturedUrl).toBe('https://api.test/v1/groups/grp_1/avatar')
    expect(capturedContentType).toBe('image/png')
    expect(res.avatar_url).toContain('abc123')
  })

  it('DELETEs /v1/groups/:id/avatar for removal', async () => {
    let capturedMethod = ''
    let capturedUrl = ''
    const fetch = scriptedFetch([
      (input, init) => {
        capturedMethod = init?.method ?? ''
        capturedUrl = typeof input === 'string' ? input : input.toString()
        return json(200, { ok: true })
      },
    ])
    const client = new AgentChatClient({ apiKey: 'k', baseUrl: 'https://api.test', fetch })
    const res = await client.removeGroupAvatar('grp_1')
    expect(capturedMethod).toBe('DELETE')
    expect(capturedUrl).toBe('https://api.test/v1/groups/grp_1/avatar')
    expect(res.ok).toBe(true)
  })
})

describe('AgentChatClient.getWebhook', () => {
  it('GETs /v1/webhooks/:id and returns a WebhookConfig', async () => {
    let capturedUrl = ''
    const fetch = scriptedFetch([
      (input) => {
        capturedUrl = typeof input === 'string' ? input : input.toString()
        return json(200, {
          id: 'wh_1',
          url: 'https://example.com/hook',
          events: ['message.new'],
          active: true,
          created_at: '2026-01-01T00:00:00Z',
        })
      },
    ])
    const client = new AgentChatClient({ apiKey: 'k', baseUrl: 'https://api.test', fetch })
    const res = await client.getWebhook('wh_1')
    expect(capturedUrl).toBe('https://api.test/v1/webhooks/wh_1')
    expect(res.url).toBe('https://example.com/hook')
    expect(res.events).toContain('message.new')
  })
})

describe('AgentChatClient.getAttachmentDownloadUrl', () => {
  it('captures the Location header from a 302 without following the redirect', async () => {
    let capturedRedirectOpt: RequestRedirect | undefined
    const fetch = scriptedFetch([
      (_, init) => {
        capturedRedirectOpt = init?.redirect
        return new Response(null, {
          status: 302,
          headers: {
            location:
              'https://storage.supabase/object/sign/attachments/abc?token=eyJabc',
          },
        })
      },
    ])
    const client = new AgentChatClient({ apiKey: 'k', baseUrl: 'https://api.test', fetch })
    const url = await client.getAttachmentDownloadUrl('att_1')
    expect(capturedRedirectOpt).toBe('manual')
    expect(url).toMatch(/^https:\/\/storage\.supabase\/object\/sign\/attachments\/abc/)
  })

  it('throws a descriptive error if the server did not return a Location header', async () => {
    const fetch = scriptedFetch([
      () => new Response(null, { status: 302, headers: {} }),
    ])
    const client = new AgentChatClient({ apiKey: 'k', baseUrl: 'https://api.test', fetch })
    await expect(client.getAttachmentDownloadUrl('att_broken')).rejects.toThrow(
      /did not return a redirect Location/,
    )
  })
})
