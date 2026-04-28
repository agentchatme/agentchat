/**
 * Inbound bridge behavior — covers:
 *   - Self-send filter: messages from our own handle are ignored, not
 *     dispatched to OpenClaw's reply pipeline (would cause agent→agent
 *     loop).
 *   - Empty-payload filter: messages with no text/attachment/data don't
 *     fire the reply pipeline.
 *   - Missing dispatcher: logs a loud error but doesn't throw (the
 *     message is durable server-side and will re-deliver on next sync).
 *   - Low-signal events (typing, presence, read-receipt) don't dispatch.
 *   - Dispatcher is invoked for real inbound messages from peers.
 */

import { describe, it, expect, vi } from 'vitest'

import { createInboundBridge } from '../../src/binding/inbound-bridge.js'
import type {
  NormalizedInbound,
  NormalizedMessage,
} from '../../src/inbound.js'
import type { AgentchatChannelConfig } from '../../src/config-schema.js'
import type { AgentchatChannelRuntime } from '../../src/runtime.js'

const config: AgentchatChannelConfig = {
  apiKey: 'ac_live_key_aaaaaaaaaaaaaaaaaaaaaaaa',
  apiBase: 'https://api.agentchat.me',
  agentHandle: 'self-agent',
  reconnect: { initialBackoffMs: 1000, maxBackoffMs: 30000, jitterRatio: 0.2 },
  ping: { intervalMs: 30000, timeoutMs: 10000 },
  outbound: { maxInFlight: 256, sendTimeoutMs: 15000 },
  observability: { logLevel: 'error', redactKeys: ['apiKey'] },
}

const emptyLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => emptyLogger,
}

function makeMessage(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    kind: 'message',
    conversationKind: 'direct',
    conversationId: 'conv_abc',
    sender: 'peer-agent',
    messageId: 'msg_1',
    clientMsgId: 'cmid_1',
    seq: 1,
    messageType: 'text',
    content: { text: 'hello' },
    metadata: {},
    status: null,
    createdAt: new Date().toISOString(),
    deliveredAt: null,
    readAt: null,
    receivedAt: Date.now(),
    ...overrides,
  }
}

function makeRuntimeStub(): AgentchatChannelRuntime {
  return {
    sendMessage: vi.fn().mockResolvedValue({ message: { id: 'out_1' } }),
  } as unknown as AgentchatChannelRuntime
}

/**
 * Build a channelRuntime mock with the full surface that
 * `dispatchInboundDirectDmWithRuntime` calls into. The helper does:
 *   routing.resolveAgentRoute → session.resolveStorePath →
 *   session.readSessionUpdatedAt → reply.resolveEnvelopeFormatOptions →
 *   reply.formatAgentEnvelope → reply.finalizeInboundContext →
 *   session.recordInboundSession → reply.dispatchReplyWithBufferedBlockDispatcher
 * The tests only care that the dispatcher is called (or not), so the
 * intermediates are stubbed minimally.
 */
function makeChannelRuntimeStub(opts: {
  dispatcher: ReturnType<typeof vi.fn>
}): unknown {
  return {
    routing: {
      resolveAgentRoute: vi.fn(({ accountId }: { accountId: string }) => ({
        agentId: 'agent-main',
        accountId,
        sessionKey: `dm:test`,
      })),
    },
    session: {
      resolveStorePath: vi.fn(() => '/tmp/test-session-store'),
      readSessionUpdatedAt: vi.fn(() => Date.now()),
      recordInboundSession: vi.fn(async () => {}),
    },
    reply: {
      resolveEnvelopeFormatOptions: vi.fn(() => ({ mode: 'agent' })),
      formatAgentEnvelope: vi.fn(({ body }: { body: string }) => body),
      finalizeInboundContext: vi.fn((ctx: unknown) => ctx),
      dispatchReplyWithBufferedBlockDispatcher: opts.dispatcher,
    },
  }
}

describe('inbound bridge', () => {
  it('ignores messages from our own handle (self-echo filter)', async () => {
    const dispatcher = vi.fn()
    const runtime = makeRuntimeStub()
    const bridge = createInboundBridge({
      accountId: 'default',
      config,
      logger: emptyLogger,
      runtime,
      channelRuntime: makeChannelRuntimeStub({ dispatcher }) as never,
      gatewayCfg: {},
      selfHandle: 'self-agent',
    })
    await bridge(makeMessage({ sender: 'self-agent' }))
    expect(dispatcher).not.toHaveBeenCalled()
    expect(runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('dispatches messages from peers', async () => {
    const dispatcher = vi.fn().mockResolvedValue(undefined)
    const runtime = makeRuntimeStub()
    const bridge = createInboundBridge({
      accountId: 'default',
      config,
      logger: emptyLogger,
      runtime,
      channelRuntime: makeChannelRuntimeStub({ dispatcher }) as never,
      gatewayCfg: {},
      selfHandle: 'self-agent',
    })
    await bridge(makeMessage({ sender: 'peer-agent' }))
    expect(dispatcher).toHaveBeenCalledTimes(1)
  })

  it('skips messages with empty content', async () => {
    const dispatcher = vi.fn()
    const bridge = createInboundBridge({
      accountId: 'default',
      config,
      logger: emptyLogger,
      runtime: makeRuntimeStub(),
      channelRuntime: makeChannelRuntimeStub({ dispatcher }) as never,
      gatewayCfg: {},
      selfHandle: 'self-agent',
    })
    await bridge(makeMessage({ content: {} }))
    expect(dispatcher).not.toHaveBeenCalled()
  })

  it('logs a loud error when dispatcher is missing, does not throw', async () => {
    const errorLogger = {
      ...emptyLogger,
      error: vi.fn(),
    }
    const bridge = createInboundBridge({
      accountId: 'default',
      config,
      logger: errorLogger,
      runtime: makeRuntimeStub(),
      // No channelRuntime → no dispatcher available.
      channelRuntime: undefined,
      gatewayCfg: {},
      selfHandle: 'self-agent',
    })
    await expect(bridge(makeMessage())).resolves.toBeUndefined()
    expect(errorLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'inbound_dispatch_unavailable' }),
      expect.stringContaining('unavailable'),
    )
  })

  it('does not dispatch on typing / presence / read-receipt events', async () => {
    const dispatcher = vi.fn()
    const bridge = createInboundBridge({
      accountId: 'default',
      config,
      logger: emptyLogger,
      runtime: makeRuntimeStub(),
      channelRuntime: makeChannelRuntimeStub({ dispatcher }) as never,
      gatewayCfg: {},
      selfHandle: 'self-agent',
    })
    const typing: NormalizedInbound = {
      kind: 'typing',
      action: 'start',
      conversationKind: 'direct',
      conversationId: 'conv_abc',
      sender: 'peer',
      receivedAt: Date.now(),
    }
    const presence: NormalizedInbound = {
      kind: 'presence',
      handle: 'peer',
      status: 'online',
      lastActiveAt: null,
      customStatus: null,
      receivedAt: Date.now(),
    }
    const read: NormalizedInbound = {
      kind: 'read-receipt',
      conversationKind: 'direct',
      conversationId: 'conv_abc',
      reader: 'peer',
      throughSeq: 5,
      at: null,
      receivedAt: Date.now(),
    }
    await bridge(typing)
    await bridge(presence)
    await bridge(read)
    expect(dispatcher).not.toHaveBeenCalled()
  })
})
