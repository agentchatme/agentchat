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

import { dispatchInboundDirectDmWithRuntime } from 'openclaw/plugin-sdk/direct-dm'
import { resolveInboundRouteEnvelopeBuilderWithRuntime } from 'openclaw/plugin-sdk/inbound-envelope'
import { recordInboundSessionAndDispatchReply } from 'openclaw/plugin-sdk/inbound-reply-dispatch'

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

/**
 * The runtime surface OpenClaw passes via channelRuntime. We only declare
 * the bits we actually call — the actual object passed at runtime is
 * fuller and is the same shape used by every bundled channel and tested
 * via openclaw/src/plugin-sdk/direct-dm.test.ts. Casting to `never` for
 * dispatchInboundDirectDmWithRuntime sidesteps a deep TS type-name conflict
 * between OpenClaw's internal cfg type and our gatewayCfg passthrough.
 */
export type ChannelRuntimeLike = {
  readonly routing?: unknown
  readonly session?: unknown
  readonly reply?: {
    readonly dispatchReplyWithBufferedBlockDispatcher?: (params: unknown) => Promise<unknown>
    readonly resolveEnvelopeFormatOptions?: unknown
    readonly formatAgentEnvelope?: unknown
    readonly finalizeInboundContext?: unknown
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

  const channelRuntime = deps.channelRuntime
  if (
    !channelRuntime ||
    typeof channelRuntime.reply?.dispatchReplyWithBufferedBlockDispatcher !== 'function'
  ) {
    // HARD degradation: gateway booted without AI wiring (e.g. tests or
    // a misconfigured deployment). The message reached the plugin but
    // there is nowhere to dispatch it to. Server-side it stays durable
    // — a restart with a properly-wired runtime drains it from sync.
    deps.logger.error(
      {
        event: 'inbound_dispatch_unavailable',
        messageId: event.messageId,
        conversationId: event.conversationId,
        conversationKind: event.conversationKind,
        sender: event.sender,
      },
      'channelRuntime unavailable — message NOT dispatched to agent (will be redelivered on next sync)',
    )
    return
  }

  const recipientHandle = selfHandle ?? 'me'
  const conversationLabel =
    event.conversationKind === 'group'
      ? `group ${event.conversationId}`
      : `dm with @${senderHandle}`
  const sendReply = async (replyText: string): Promise<void> => {
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
  }
  const deliver = async (payload: { text?: string; blocks?: unknown[] }) => {
    const replyText = payload.text ?? extractText(payload.blocks)
    await sendReply(replyText)
  }

  try {
    if (event.conversationKind === 'direct') {
      // Direct DM path — use OpenClaw's canonical helper which chains:
      //   1. resolveAgentRoute      (assigns sessionKey, agentId)
      //   2. buildEnvelope          (formats body with sender label)
      //   3. finalizeInboundContext (PascalCase ctx with all required fields)
      //   4. recordInboundSession   (opens the session — was missing in 0.6.13)
      //   5. dispatchReply...       (runs the LLM)
      // We call the helper instead of dispatcher directly because skipping
      // step 4 leaves the session in `sessionId=unknown state=processing`
      // forever, and the health monitor restarts the WS, killing the in-
      // flight message. See the diagnostic line:
      //   stuck session: sessionId=unknown sessionKey=agentchat:default:dm:X
      // Cast cfg + runtime to `never` because OpenClaw's internal
      // OpenClawConfig type is not part of the public plugin-sdk surface,
      // and our gatewayCfg is a passthrough of the same object; the runtime
      // shape matches openclaw/src/plugin-sdk/direct-dm.test.ts mocks.
      await dispatchInboundDirectDmWithRuntime({
        cfg: deps.gatewayCfg as never,
        runtime: { channel: channelRuntime } as never,
        channel: 'agentchat',
        channelLabel: 'AgentChat',
        accountId: deps.accountId,
        peer: { kind: 'direct', id: senderHandle },
        senderId: senderHandle,
        senderAddress: `@${senderHandle}`,
        recipientAddress: `@${recipientHandle}`,
        conversationLabel,
        rawBody: body,
        messageId: event.messageId,
        timestamp:
          typeof event.createdAt === 'number' ? event.createdAt : Date.parse(event.createdAt),
        provider: 'agentchat',
        surface: 'agentchat',
        deliver,
        onRecordError: (err: unknown) => {
          deps.logger.error(
            { err: err instanceof Error ? err.message : String(err), messageId: event.messageId },
            'recordInboundSession failed',
          )
        },
        onDispatchError: (err: unknown, info: { kind: string }) => {
          deps.logger.error(
            {
              err: err instanceof Error ? err.message : String(err),
              messageId: event.messageId,
              kind: info.kind,
            },
            'inbound dispatch failed',
          )
        },
      })
    } else {
      // Group path — no `dispatchInboundGroup*` wrapper exists in
      // plugin-sdk yet, so we assemble the same pipeline inline using the
      // generic helpers that the direct-DM wrapper itself uses internally:
      //
      //   resolveInboundRouteEnvelopeBuilderWithRuntime  (plugin-sdk)
      //   reply.finalizeInboundContext                   (channelRuntime)
      //   recordInboundSessionAndDispatchReply           (plugin-sdk)
      //
      // This is byte-equivalent to `dispatchInboundDirectDmWithRuntime`'s
      // body — see openclaw/dist/direct-dm-*.js — only `peer.kind` and
      // `ChatType` differ. Critically: this path NOW calls
      // recordInboundSession before dispatch, so groups can no longer
      // hit the `sessionId=unknown state=processing` stuck-session bug
      // that broke direct DMs in 0.6.13 and that this fix closes for
      // groups in 0.6.17.
      const ts =
        typeof event.createdAt === 'number'
          ? event.createdAt
          : Date.parse(event.createdAt)
      const runtime = channelRuntime as never
      const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
        cfg: deps.gatewayCfg as never,
        channel: 'agentchat',
        accountId: deps.accountId,
        peer: { kind: 'group', id: event.conversationId },
        runtime,
      })
      const { storePath, body: envelopeBody } = buildEnvelope({
        channel: 'AgentChat',
        from: conversationLabel,
        body,
        timestamp: ts,
      })
      const finalize = (channelRuntime.reply as { finalizeInboundContext: (c: Record<string, unknown>) => Record<string, unknown> }).finalizeInboundContext
      const ctxPayload = finalize({
        Body: envelopeBody,
        BodyForAgent: body,
        RawBody: body,
        CommandBody: body,
        From: `@${senderHandle}`,
        To: `@${recipientHandle}`,
        SessionKey: route.sessionKey,
        AccountId: deps.accountId,
        ChatType: 'group',
        ConversationLabel: conversationLabel,
        SenderId: senderHandle,
        Provider: 'agentchat',
        Surface: 'agentchat',
        MessageSid: event.messageId,
        MessageSidFull: event.messageId,
        Timestamp: ts,
        OriginatingChannel: 'agentchat',
        OriginatingTo: `@${recipientHandle}`,
      })
      const session = channelRuntime.session as { recordInboundSession: never }
      await recordInboundSessionAndDispatchReply({
        cfg: deps.gatewayCfg as never,
        channel: 'agentchat',
        accountId: deps.accountId,
        agentId: route.agentId,
        routeSessionKey: route.sessionKey,
        storePath,
        ctxPayload: ctxPayload as never,
        recordInboundSession: session.recordInboundSession,
        dispatchReplyWithBufferedBlockDispatcher: channelRuntime.reply!
          .dispatchReplyWithBufferedBlockDispatcher! as never,
        deliver,
        onRecordError: (err: unknown) => {
          deps.logger.error(
            { err: err instanceof Error ? err.message : String(err), messageId: event.messageId },
            'recordInboundSession failed (group)',
          )
        },
        onDispatchError: (err: unknown, info: { kind: string }) => {
          deps.logger.error(
            {
              err: err instanceof Error ? err.message : String(err),
              messageId: event.messageId,
              kind: info.kind,
            },
            'inbound dispatch failed (group)',
          )
        },
      })
    }
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
