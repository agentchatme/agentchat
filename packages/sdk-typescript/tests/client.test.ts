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
