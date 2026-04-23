/**
 * Inbound bridge — NormalizedInbound → OpenClaw's shared inbound dispatch.
 *
 * The runtime's WS delivers typed `NormalizedInbound` events. We translate
 * each one into the canonical OpenClaw flow so the agent can actually
 * "see" the message: a text message triggers the reply pipeline, which
 * runs the agent, and the agent's reply payload comes back through our
 * `deliver` callback — which in turn routes back to AgentChat via the same
 * runtime's `sendMessage`.
 *
 * Non-text events (presence, typing, read receipts, rate-limit warnings,
 * group invites, group deletions) are surfaced through logs +
 * gateway status for now; they do NOT trigger the reply pipeline. Future
 * work: expose them as `system` messages the agent can subscribe to.
 *
 * Self-sends are filtered: the AgentChat server emits `message.new` for
 * both sides of every send, so we'd otherwise feed our own outbound back
 * to the agent. Detection is by handle match against the configured
 * `agentHandle`.
 */

import type { Logger } from '../log.js'
import type { AgentchatChannelConfig } from '../config-schema.js'
import type {
  NormalizedInbound,
  NormalizedMessage,
  NormalizedGroupInvite,
  NormalizedGroupDeleted,
} from '../inbound.js'
import type { AgentchatChannelRuntime } from '../runtime.js'

export interface InboundBridgeDeps {
  readonly accountId: string
  readonly config: AgentchatChannelConfig
  readonly logger: Logger
  readonly runtime: AgentchatChannelRuntime
  /**
   * OpenClaw's channelRuntime surface — exposed on `ChannelGatewayContext`.
   * When `undefined` (e.g. during tests or when the gateway was booted
   * without AI wiring) we degrade to log-only: the message is visible in
   * logs but no reply is generated.
   */
  readonly channelRuntime?: ChannelRuntimeLike
  readonly gatewayCfg: unknown
  readonly selfHandle?: string
}

export type ChannelRuntimeLike = {
  readonly reply?: {
    readonly dispatchReplyWithBufferedBlockDispatcher?: (params: unknown) => Promise<unknown>
  }
}

/**
 * Return a `(NormalizedInbound) => void` handler suitable for plugging
 * into `ChannelRuntimeHandlers.onInbound`. Call this once per account
 * inside `gateway.startAccount`.
 */
export function createInboundBridge(deps: InboundBridgeDeps) {
  return async function onInbound(event: NormalizedInbound): Promise<void> {
    switch (event.kind) {
      case 'message':
        await handleMessage(deps, event)
        return
      case 'group-invite':
        handleGroupInvite(deps, event)
        return
      case 'group-deleted':
        handleGroupDeleted(deps, event)
        return
      case 'read-receipt':
      case 'typing':
      case 'presence':
      case 'rate-limit-warning':
      case 'unknown':
        // Low-signal events — surface to logs, do not trigger dispatch.
        deps.logger.debug({ event: event.kind }, 'inbound signal')
        return
    }
  }
}

async function handleMessage(
  deps: InboundBridgeDeps,
  event: NormalizedMessage,
): Promise<void> {
  const senderHandle = event.sender
  const selfHandle = deps.selfHandle ?? deps.config.agentHandle
  if (selfHandle && senderHandle === selfHandle) {
    // Server echoes our own send back over WS. Ignore so the agent does
    // not reply to itself.
    deps.logger.trace(
      { messageId: event.messageId, sender: senderHandle },
      'inbound self-message — ignored',
    )
    return
  }

  const body = typeof event.content.text === 'string' ? event.content.text : ''
  if (!body && !event.content.attachmentId && !event.content.data) {
    // Empty payload — nothing meaningful to dispatch.
    return
  }

  const dispatcher = deps.channelRuntime?.reply?.dispatchReplyWithBufferedBlockDispatcher
  if (typeof dispatcher !== 'function') {
    // This is a HARD degradation: a message reached the plugin but the
    // OpenClaw runtime has no reply pipeline attached, so the agent never
    // sees it. Log at error so operators can correlate "messages arrive,
    // no replies go out" with the missing wiring immediately, rather than
    // discovering it via a user-reported silence. The message itself is
    // durable server-side; a restart with a properly-wired runtime will
    // drain it from /v1/messages/sync.
    deps.logger.error(
      {
        event: 'inbound_dispatch_unavailable',
        messageId: event.messageId,
        conversationId: event.conversationId,
        conversationKind: event.conversationKind,
        sender: event.sender,
      },
      'channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher unavailable — message NOT dispatched to agent (will be redelivered on next sync)',
    )
    return
  }

  const recipientHandle = selfHandle ?? 'me'
  const conversationLabel =
    event.conversationKind === 'group'
      ? `group ${event.conversationId}`
      : `dm with @${senderHandle}`

  try {
    await dispatcher({
      cfg: deps.gatewayCfg,
      ctx: {
        channel: 'agentchat',
        channelLabel: 'AgentChat',
        accountId: deps.accountId,
        conversationId: event.conversationId,
        conversationLabel,
        senderId: senderHandle,
        senderAddress: `@${senderHandle}`,
        recipientAddress: `@${recipientHandle}`,
        messageId: event.messageId,
        rawBody: body,
        timestamp: event.createdAt,
        chatType: event.conversationKind === 'group' ? 'group' : 'direct',
      },
      dispatcherOptions: {
        deliver: async (payload: { text?: string; blocks?: unknown[] }) => {
          const replyText = payload.text ?? extractText(payload.blocks)
          if (!replyText) return
          const target =
            event.conversationKind === 'group'
              ? { kind: 'group' as const, conversationId: event.conversationId }
              : { kind: 'direct' as const, to: senderHandle }
          await deps.runtime.sendMessage({
            ...target,
            type: 'text',
            content: { text: replyText },
            metadata: { reply_to: event.messageId },
          })
        },
      },
    })
  } catch (err) {
    deps.logger.error(
      {
        err: err instanceof Error ? err.message : String(err),
        messageId: event.messageId,
      },
      'inbound dispatch failed',
    )
  }
}

function handleGroupInvite(deps: InboundBridgeDeps, event: NormalizedGroupInvite): void {
  deps.logger.info(
    {
      event: 'group-invite',
      groupId: event.groupId,
      inviterHandle: event.inviterHandle,
      groupName: event.groupName,
    },
    'received group invite',
  )
}

function handleGroupDeleted(deps: InboundBridgeDeps, event: NormalizedGroupDeleted): void {
  deps.logger.warn(
    {
      event: 'group-deleted',
      groupId: event.groupId,
      deletedBy: event.deletedByHandle,
    },
    'group was deleted',
  )
}

function extractText(blocks: unknown[] | undefined): string {
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const block of blocks) {
    if (block && typeof block === 'object' && 'text' in block) {
      const text = (block as { text: unknown }).text
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.join('\n\n').trim()
}
