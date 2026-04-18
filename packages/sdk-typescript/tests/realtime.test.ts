import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RealtimeClient } from '../src/realtime.js'
import type { WsMessage, Message } from '../src/types/index.js'

// ─── Test double for WebSocket ─────────────────────────────────────────────
//
// Browser WebSocket has a tiny, well-defined surface — constructor, four
// event handler slots, `send()`, `close()`, `readyState`. The mock below
// implements just enough of it to exercise every RealtimeClient path. We
// inject the constructor via `RealtimeOptions.webSocket`, which the SDK
// uses in place of `globalThis.WebSocket` / the `ws` fallback.

type Listener = (event: Event) => void

interface MockOpenEvent extends Event {}
interface MockMessageEvent extends Event {
  data: string
}
interface MockCloseEvent extends Event {
  code: number
  reason: string
  wasClean: boolean
}

class MockWebSocket {
  static readonly instances: MockWebSocket[] = []
  static latest(): MockWebSocket {
    const last = MockWebSocket.instances.at(-1)
    if (!last) throw new Error('MockWebSocket.latest(): no instance yet')
    return last
  }

  static reset() {
    MockWebSocket.instances.length = 0
  }

  readonly url: string
  readyState = 0 // CONNECTING
  readonly sent: string[] = []
  closed: { code: number; reason: string } | null = null

  onopen: Listener | null = null
  onmessage: Listener | null = null
  onclose: Listener | null = null
  onerror: Listener | null = null

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  // ─── Driven by tests ──────────────────────────────────────────────────
  simulateOpen() {
    this.readyState = 1 // OPEN
    this.onopen?.({ type: 'open' } as MockOpenEvent)
  }

  simulateMessage(data: unknown) {
    this.onmessage?.({
      type: 'message',
      data: typeof data === 'string' ? data : JSON.stringify(data),
    } as MockMessageEvent)
  }

  simulateClose(code = 1006, reason = 'abnormal', wasClean = false) {
    this.readyState = 3 // CLOSED
    this.onclose?.({
      type: 'close',
      code,
      reason,
      wasClean,
    } as MockCloseEvent)
  }

  // ─── WebSocket surface the SDK uses ───────────────────────────────────
  send(data: string) {
    this.sent.push(data)
  }

  close(code = 1000, reason = '') {
    this.readyState = 3
    this.closed = { code, reason }
  }
}

// Cast to satisfy the `typeof globalThis.WebSocket` parameter of the SDK.
const MockWebSocketCtor = MockWebSocket as unknown as typeof globalThis.WebSocket

// Helper — builds a message.new envelope for a given conversation + seq.
function messageNew(conversationId: string, seq: number, extra?: Partial<Message>): WsMessage {
  return {
    type: 'message.new',
    payload: {
      id: `msg_${seq}`,
      conversation_id: conversationId,
      sender: '@other',
      client_msg_id: `c_${seq}`,
      seq,
      type: 'text',
      content: { text: `hi ${seq}` },
      metadata: {},
      status: 'stored',
      created_at: '2026-01-01T00:00:00Z',
      delivered_at: null,
      read_at: null,
      ...extra,
    },
  } as unknown as WsMessage
}

beforeEach(() => {
  MockWebSocket.reset()
})

afterEach(() => {
  vi.useRealTimers()
})

// ─── Tests ────────────────────────────────────────────────────────────────

describe('RealtimeClient — handshake', () => {
  it('sends HELLO on open and fires onConnect after hello.ok', async () => {
    const rt = new RealtimeClient({
      apiKey: 'sk_test',
      webSocket: MockWebSocketCtor,
      reconnect: false,
    })
    const onConnect = vi.fn()
    rt.onConnect(onConnect)

    await rt.connect()
    const ws = MockWebSocket.latest()
    ws.simulateOpen()

    expect(ws.sent).toHaveLength(1)
    expect(JSON.parse(ws.sent[0])).toEqual({ type: 'hello', api_key: 'sk_test' })
    expect(onConnect).not.toHaveBeenCalled() // only after hello.ok

    ws.simulateMessage({ type: 'hello.ok' })
    expect(onConnect).toHaveBeenCalledOnce()
    expect(rt.isConnected).toBe(true)

    rt.disconnect()
  })

  it('emits ConnectionError on HELLO ack timeout', async () => {
    vi.useFakeTimers()
    const rt = new RealtimeClient({
      apiKey: 'k',
      webSocket: MockWebSocketCtor,
      reconnect: false,
    })
    const onError = vi.fn()
    rt.onError(onError)

    await rt.connect()
    MockWebSocket.latest().simulateOpen()

    vi.advanceTimersByTime(5_000) // > HELLO_ACK_TIMEOUT_MS (4s)
    expect(onError).toHaveBeenCalled()
    expect(onError.mock.calls[0][0].message).toMatch(/HELLO ack timeout/)

    rt.disconnect()
  })
})

describe('RealtimeClient — message dispatch', () => {
  it('delivers message.new events to registered handlers', async () => {
    const rt = new RealtimeClient({
      apiKey: 'k',
      webSocket: MockWebSocketCtor,
      reconnect: false,
    })
    const onMessage = vi.fn()
    rt.on('message.new', onMessage)

    await rt.connect()
    const ws = MockWebSocket.latest()
    ws.simulateOpen()
    ws.simulateMessage({ type: 'hello.ok' })

    ws.simulateMessage(messageNew('conv_1', 1))
    ws.simulateMessage(messageNew('conv_1', 2))

    expect(onMessage).toHaveBeenCalledTimes(2)
    const firstPayload = (onMessage.mock.calls[0][0] as WsMessage).payload as { seq: number }
    expect(firstPayload.seq).toBe(1)

    rt.disconnect()
  })

  it('ignores frames that arrive before hello.ok (other than hello.ok itself)', async () => {
    const rt = new RealtimeClient({
      apiKey: 'k',
      webSocket: MockWebSocketCtor,
      reconnect: false,
    })
    const onMessage = vi.fn()
    rt.on('message.new', onMessage)

    await rt.connect()
    const ws = MockWebSocket.latest()
    ws.simulateOpen()

    ws.simulateMessage(messageNew('conv_1', 1)) // pre-ack — dropped
    ws.simulateMessage({ type: 'hello.ok' })
    ws.simulateMessage(messageNew('conv_1', 2)) // post-ack — delivered

    expect(onMessage).toHaveBeenCalledTimes(1)

    rt.disconnect()
  })
})

describe('RealtimeClient — per-conversation seq ordering', () => {
  it('delivers out-of-order seqs in ascending order once the gap closes', async () => {
    const rt = new RealtimeClient({
      apiKey: 'k',
      webSocket: MockWebSocketCtor,
      reconnect: false,
    })
    const seen: number[] = []
    rt.on('message.new', (evt) => {
      seen.push((evt.payload as { seq: number }).seq)
    })

    await rt.connect()
    const ws = MockWebSocket.latest()
    ws.simulateOpen()
    ws.simulateMessage({ type: 'hello.ok' })

    ws.simulateMessage(messageNew('c', 1)) // anchor
    ws.simulateMessage(messageNew('c', 3)) // buffered (gap at 2)
    ws.simulateMessage(messageNew('c', 4)) // buffered
    expect(seen).toEqual([1])

    ws.simulateMessage(messageNew('c', 2)) // closes the gap
    expect(seen).toEqual([1, 2, 3, 4])

    rt.disconnect()
  })

  it('recovers a gap via client.getMessages after the gap window expires', async () => {
    vi.useFakeTimers()
    const getMessages = vi.fn(
      async (_conv: string, opts: { afterSeq?: number }): Promise<Message[]> => {
        expect(opts.afterSeq).toBe(1) // expectedSeq=2 → afterSeq=1
        return [
          (messageNew('c', 2).payload as unknown) as Message,
        ]
      },
    )
    const mockClient = {
      getMessages,
      sync: vi.fn(),
      syncAck: vi.fn(),
    } as unknown as import('../src/client.js').AgentChatClient

    const onGap = vi.fn()
    const rt = new RealtimeClient({
      apiKey: 'k',
      webSocket: MockWebSocketCtor,
      reconnect: false,
      client: mockClient,
      autoDrainOnConnect: false,
      onSequenceGap: onGap,
    })
    const seen: number[] = []
    rt.on('message.new', (evt) => {
      seen.push((evt.payload as { seq: number }).seq)
    })

    await rt.connect()
    const ws = MockWebSocket.latest()
    ws.simulateOpen()
    ws.simulateMessage({ type: 'hello.ok' })

    ws.simulateMessage(messageNew('c', 1))
    ws.simulateMessage(messageNew('c', 3))
    expect(seen).toEqual([1])

    // Advance past GAP_FILL_WINDOW_MS (2000ms).
    await vi.advanceTimersByTimeAsync(2_100)
    // Let the getMessages microtask settle.
    await vi.runAllTimersAsync()

    expect(getMessages).toHaveBeenCalledOnce()
    expect(seen).toEqual([1, 2, 3])
    expect(onGap).toHaveBeenCalledOnce()
    expect(onGap.mock.calls[0][0]).toMatchObject({
      conversationId: 'c',
      recovered: true,
      reason: 'gap_filled',
    })

    rt.disconnect()
  })

  it('surfaces onSequenceGap with recovered:false when no client is available', async () => {
    vi.useFakeTimers()
    const onGap = vi.fn()
    const rt = new RealtimeClient({
      apiKey: 'k',
      webSocket: MockWebSocketCtor,
      reconnect: false,
      onSequenceGap: onGap,
    })
    const seen: number[] = []
    rt.on('message.new', (evt) => {
      seen.push((evt.payload as { seq: number }).seq)
    })

    await rt.connect()
    const ws = MockWebSocket.latest()
    ws.simulateOpen()
    ws.simulateMessage({ type: 'hello.ok' })

    ws.simulateMessage(messageNew('c', 1))
    ws.simulateMessage(messageNew('c', 3)) // gap at 2

    await vi.advanceTimersByTimeAsync(2_100)
    await vi.runAllTimersAsync()

    expect(seen).toEqual([1, 3]) // skipped past, no recovery possible
    expect(onGap).toHaveBeenCalledOnce()
    expect(onGap.mock.calls[0][0]).toMatchObject({
      recovered: false,
      reason: 'gap_fill_unavailable',
    })

    rt.disconnect()
  })
})

describe('RealtimeClient — reconnect', () => {
  it('schedules a reconnect with jittered backoff after onclose', async () => {
    vi.useFakeTimers()
    const rt = new RealtimeClient({
      apiKey: 'k',
      webSocket: MockWebSocketCtor,
      reconnect: true,
      reconnectInterval: 1_000,
      maxReconnectInterval: 10_000,
    })

    await rt.connect()
    MockWebSocket.latest().simulateClose(1006, 'abnormal', false)

    // Only one instance so far; after the reconnect fires a second one
    // should appear. Jitter is ±25% of 1000ms → upper bound ~1250ms.
    expect(MockWebSocket.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2_000)
    // `connect()` on the scheduled tick is async — drain microtasks.
    await vi.runAllTimersAsync()
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2)

    rt.disconnect()
  })

  it('does not reconnect after disconnect()', async () => {
    vi.useFakeTimers()
    const rt = new RealtimeClient({
      apiKey: 'k',
      webSocket: MockWebSocketCtor,
      reconnect: true,
      reconnectInterval: 100,
    })
    await rt.connect()
    const first = MockWebSocket.latest()
    rt.disconnect()

    // disconnect() closes the socket directly; any later simulateClose
    // would be a no-op, but schedule a tick and make sure no second
    // instance appears.
    first.simulateClose(1000, 'bye', true)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.runAllTimersAsync()
    expect(MockWebSocket.instances).toHaveLength(1)
  })

  it('fires onDisconnect handlers on every close', async () => {
    const rt = new RealtimeClient({
      apiKey: 'k',
      webSocket: MockWebSocketCtor,
      reconnect: false,
    })
    const onDisconnect = vi.fn()
    rt.onDisconnect(onDisconnect)

    await rt.connect()
    MockWebSocket.latest().simulateClose(1011, 'server error', false)

    expect(onDisconnect).toHaveBeenCalledWith({
      code: 1011,
      reason: 'server error',
      wasClean: false,
    })

    rt.disconnect()
  })
})

describe('RealtimeClient — offline drain on reconnect', () => {
  it('calls client.sync + syncAck and dispatches envelopes on hello.ok', async () => {
    const envelopes = [
      { delivery_id: 10, message: messageNew('c', 1).payload as unknown as Message },
      { delivery_id: 11, message: messageNew('c', 2).payload as unknown as Message },
    ]
    const sync = vi.fn()
    let call = 0
    sync.mockImplementation(async () => {
      call++
      return call === 1 ? { envelopes } : { envelopes: [] }
    })
    const syncAck = vi.fn(async () => ({ ok: true }))

    const mockClient = {
      sync,
      syncAck,
      getMessages: vi.fn(),
    } as unknown as import('../src/client.js').AgentChatClient

    const rt = new RealtimeClient({
      apiKey: 'k',
      webSocket: MockWebSocketCtor,
      reconnect: false,
      client: mockClient,
      // autoDrainOnConnect defaults to true when client is set
    })
    const onMessage = vi.fn()
    rt.on('message.new', onMessage)

    await rt.connect()
    const ws = MockWebSocket.latest()
    ws.simulateOpen()
    ws.simulateMessage({ type: 'hello.ok' })

    // drainOfflineEnvelopes runs asynchronously on hello.ok — yield.
    await new Promise((r) => setTimeout(r, 0))

    expect(sync).toHaveBeenCalled()
    expect(syncAck).toHaveBeenCalledWith(11)
    expect(onMessage).toHaveBeenCalledTimes(2)

    rt.disconnect()
  })

  it('skips auto-drain when client is omitted', async () => {
    const rt = new RealtimeClient({
      apiKey: 'k',
      webSocket: MockWebSocketCtor,
      reconnect: false,
    })
    await rt.connect()
    const ws = MockWebSocket.latest()
    ws.simulateOpen()
    ws.simulateMessage({ type: 'hello.ok' })

    // Nothing to assert beyond "doesn't throw" — the goal here is to
    // pin the "no client → no drain" path against a future refactor.
    await new Promise((r) => setTimeout(r, 0))
    rt.disconnect()
  })
})
