/**
 * Inbound normalizer — AgentChat server events → channel-neutral shape.
 *
 * Responsibilities:
 *   - Validate every server frame against a Zod schema. Unknown shapes
 *     surface as `validation` errors (the transport catches them and drops
 *     the frame without killing the connection).
 *   - Translate AgentChat-native payloads into a stable, plugin-internal
 *     `NormalizedInbound` shape. The OpenClaw channel binding (P7 runtime
 *     wiring) adapts this further to the gateway's `ChannelInboundMessage`
 *     contract.
 *   - Classify conversation kind (direct vs group) from the `dir_*`/`grp_*`
 *     prefix convention so consumers don't need to grep prefixes themselves.
 *
 * Why this module exists (rather than passing raw frames up):
 *   - The WS client is pure transport; it shouldn't know what
 *     `message.new` means semantically.
 *   - OpenClaw's ChannelInboundMessage has a specific shape (thread id,
 *     content parts, attachments, sender identity). Converting from
 *     AgentChat's wire format in one place is the only sane way to keep
 *     the mapping auditable.
 *   - Per-event Zod schemas make drift between plugin and server obvious
 *     and loud — a server field rename surfaces as a validation error
 *     caught in CI long before it goes to prod.
 */

import { z } from 'zod'

import type { InboundFrame } from './ws-client.js'
import { AgentChatChannelError } from './errors.js'
import type { UnixMillis } from './types.js'

// ─── Conversation-id prefix convention ─────────────────────────────────
//
// Mirrors `apps/api-server/src/services/{message,group}.service.ts`:
//   - DM conversations are minted via `generateId('conv')` → `conv_*`
//   - Groups are minted via `generateId('grp')` → `grp_*`
//
// We also accept the legacy `dir_` prefix for DMs — pre-production test
// fixtures and docs sometimes used it, and no harm in tolerating both.

const DIRECT_PREFIXES = ['conv_', 'dir_'] as const
const GROUP_PREFIX = 'grp_'

export type ConversationKind = 'direct' | 'group'

export function classifyConversationId(id: string): ConversationKind | null {
  for (const p of DIRECT_PREFIXES) {
    if (id.startsWith(p)) return 'direct'
  }
  if (id.startsWith(GROUP_PREFIX)) return 'group'
  return null
}

// ─── Zod schemas for server events ─────────────────────────────────────
//
// Every field we actually read is `required`; anything else is tolerated
// via `.passthrough()` so a server-side addition doesn't break the plugin.
// Status enum is mirrored from `agentchat/packages/sdk-typescript/src/types/message.ts`.

const messageContentSchema = z
  .object({
    text: z.string().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
    attachment_id: z.string().optional(),
  })
  .passthrough()

const messageSchema = z
  .object({
    id: z.string(),
    conversation_id: z.string(),
    sender: z.string(),
    client_msg_id: z.string(),
    seq: z.number().int().nonnegative(),
    type: z.enum(['text', 'structured', 'file', 'system']),
    content: messageContentSchema,
    metadata: z.record(z.string(), z.unknown()).default({}),
    // Per-recipient delivery state lives in `message_deliveries` since
    // migration 011 — the `messages` row no longer carries `status`,
    // `delivered_at`, or `read_at`. Fresh-send envelopes over WS omit
    // them entirely; the drain path (syncUndelivered) still attaches
    // `status: 'stored'` for backlogged frames. Accept both shapes.
    status: z.enum(['stored', 'delivered', 'read']).optional(),
    created_at: z.string(),
    delivered_at: z.string().nullable().optional(),
    read_at: z.string().nullable().optional(),
  })
  .passthrough()

const messageNewSchema = messageSchema

const messageReadSchema = z
  .object({
    conversation_id: z.string(),
    // Per-agent read cursor. Everything with seq <= through_seq is read.
    through_seq: z.number().int().nonnegative(),
    // Handle of the reader (who moved their cursor).
    reader: z.string(),
    at: z.string().optional(),
  })
  .passthrough()

const typingSchema = z
  .object({
    conversation_id: z.string(),
    sender: z.string(),
  })
  .passthrough()

const presenceUpdateSchema = z
  .object({
    handle: z.string(),
    status: z.enum(['online', 'away', 'offline']),
    last_active_at: z.string().optional(),
    custom_status: z.string().nullable().optional(),
  })
  .passthrough()

const rateLimitWarningSchema = z
  .object({
    endpoint: z.string().optional(),
    limit: z.number().optional(),
    remaining: z.number().optional(),
    reset_at: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough()

const groupInviteReceivedSchema = z
  .object({
    id: z.string(),
    group_id: z.string(),
    group_name: z.string(),
    group_description: z.string().nullable().optional(),
    group_avatar_url: z.string().nullable().optional(),
    group_member_count: z.number().int().nonnegative(),
    inviter_handle: z.string(),
    created_at: z.string(),
  })
  .passthrough()

const groupDeletedSchema = z
  .object({
    group_id: z.string(),
    deleted_by_handle: z.string(),
    deleted_at: z.string(),
  })
  .passthrough()

// ─── Normalized shapes ─────────────────────────────────────────────────

export interface NormalizedMessage {
  readonly kind: 'message'
  readonly conversationKind: ConversationKind
  readonly conversationId: string
  /** Sender handle. */
  readonly sender: string
  readonly messageId: string
  readonly clientMsgId: string
  readonly seq: number
  readonly messageType: 'text' | 'structured' | 'file' | 'system'
  readonly content: {
    readonly text?: string
    readonly data?: Record<string, unknown>
    readonly attachmentId?: string
  }
  readonly metadata: Record<string, unknown>
  /**
   * Per-recipient delivery state. Since migration 011, per-recipient state
   * lives on `message_deliveries`, not the message row — so fresh-send
   * `message.new` envelopes have no status field. Drain-path (sync /
   * undelivered) envelopes still include `'stored'`. `null` means the
   * server didn't attach one; callers that need the authoritative state
   * should query `GET /v1/messages/sync` or `/delivery-receipts`.
   */
  readonly status: 'stored' | 'delivered' | 'read' | null
  readonly createdAt: string
  readonly deliveredAt: string | null
  readonly readAt: string | null
  readonly receivedAt: UnixMillis
}

export interface NormalizedReadReceipt {
  readonly kind: 'read-receipt'
  readonly conversationKind: ConversationKind
  readonly conversationId: string
  readonly reader: string
  readonly throughSeq: number
  readonly at: string | null
  readonly receivedAt: UnixMillis
}

export interface NormalizedTyping {
  readonly kind: 'typing'
  readonly action: 'start' | 'stop'
  readonly conversationKind: ConversationKind
  readonly conversationId: string
  readonly sender: string
  readonly receivedAt: UnixMillis
}

export interface NormalizedPresence {
  readonly kind: 'presence'
  readonly handle: string
  readonly status: 'online' | 'away' | 'offline'
  readonly lastActiveAt: string | null
  readonly customStatus: string | null
  readonly receivedAt: UnixMillis
}

export interface NormalizedRateLimitWarning {
  readonly kind: 'rate-limit-warning'
  readonly endpoint: string | null
  readonly limit: number | null
  readonly remaining: number | null
  readonly resetAt: string | null
  readonly message: string | null
  readonly receivedAt: UnixMillis
}

export interface NormalizedGroupInvite {
  readonly kind: 'group-invite'
  readonly inviteId: string
  readonly groupId: string
  readonly groupName: string
  readonly groupDescription: string | null
  readonly groupAvatarUrl: string | null
  readonly groupMemberCount: number
  readonly inviterHandle: string
  readonly createdAt: string
  readonly receivedAt: UnixMillis
}

export interface NormalizedGroupDeleted {
  readonly kind: 'group-deleted'
  readonly groupId: string
  readonly deletedByHandle: string
  readonly deletedAt: string
  readonly receivedAt: UnixMillis
}

/**
 * Unknown server event — arrived over the wire but isn't in our explicit
 * handler set. We still surface it (the gateway may want to log it or
 * forward it), but with a `type` field so downstream can discriminate.
 */
export interface NormalizedUnknown {
  readonly kind: 'unknown'
  readonly type: string
  readonly payload: Record<string, unknown>
  readonly receivedAt: UnixMillis
}

export type NormalizedInbound =
  | NormalizedMessage
  | NormalizedReadReceipt
  | NormalizedTyping
  | NormalizedPresence
  | NormalizedRateLimitWarning
  | NormalizedGroupInvite
  | NormalizedGroupDeleted
  | NormalizedUnknown

// ─── Normalize entrypoint ──────────────────────────────────────────────

/**
 * Normalize a raw inbound frame into a channel-neutral shape.
 *
 * Throws `AgentChatChannelError` with class `validation` if the payload
 * fails its schema. Callers (the runtime) should log + drop the frame
 * rather than propagate the throw — the connection stays healthy.
 */
export function normalizeInbound(frame: InboundFrame): NormalizedInbound {
  switch (frame.type) {
    case 'message.new':
      return normalizeMessageNew(frame)
    case 'message.read':
      return normalizeMessageRead(frame)
    case 'typing.start':
      return normalizeTyping(frame, 'start')
    case 'typing.stop':
      return normalizeTyping(frame, 'stop')
    case 'presence.update':
      return normalizePresence(frame)
    case 'rate_limit.warning':
      return normalizeRateLimitWarning(frame)
    case 'group.invite.received':
      return normalizeGroupInvite(frame)
    case 'group.deleted':
      return normalizeGroupDeleted(frame)
    default:
      return {
        kind: 'unknown',
        type: frame.type,
        payload: frame.payload,
        receivedAt: frame.receivedAt,
      }
  }
}

function validate<T>(schema: z.ZodType<T>, payload: unknown, eventType: string): T {
  const parsed = schema.safeParse(payload)
  if (!parsed.success) {
    throw new AgentChatChannelError(
      'validation',
      `inbound ${eventType} schema invalid: ${parsed.error.message}`,
      { cause: parsed.error },
    )
  }
  return parsed.data
}

function requireConvKind(conversationId: string, eventType: string): ConversationKind {
  const kind = classifyConversationId(conversationId)
  if (!kind) {
    throw new AgentChatChannelError(
      'validation',
      `inbound ${eventType} has unknown conversation id prefix: ${conversationId}`,
    )
  }
  return kind
}

function normalizeMessageNew(frame: InboundFrame): NormalizedMessage {
  const msg = validate(messageNewSchema, frame.payload, 'message.new')
  const conversationKind = requireConvKind(msg.conversation_id, 'message.new')
  return {
    kind: 'message',
    conversationKind,
    conversationId: msg.conversation_id,
    sender: msg.sender,
    messageId: msg.id,
    clientMsgId: msg.client_msg_id,
    seq: msg.seq,
    messageType: msg.type,
    content: {
      text: msg.content.text,
      data: msg.content.data,
      attachmentId: msg.content.attachment_id,
    },
    metadata: msg.metadata,
    status: msg.status ?? null,
    createdAt: msg.created_at,
    deliveredAt: msg.delivered_at ?? null,
    readAt: msg.read_at ?? null,
    receivedAt: frame.receivedAt,
  }
}

function normalizeMessageRead(frame: InboundFrame): NormalizedReadReceipt {
  const body = validate(messageReadSchema, frame.payload, 'message.read')
  const conversationKind = requireConvKind(body.conversation_id, 'message.read')
  return {
    kind: 'read-receipt',
    conversationKind,
    conversationId: body.conversation_id,
    reader: body.reader,
    throughSeq: body.through_seq,
    at: body.at ?? null,
    receivedAt: frame.receivedAt,
  }
}

function normalizeTyping(frame: InboundFrame, action: 'start' | 'stop'): NormalizedTyping {
  const body = validate(typingSchema, frame.payload, `typing.${action}`)
  const conversationKind = requireConvKind(body.conversation_id, `typing.${action}`)
  return {
    kind: 'typing',
    action,
    conversationKind,
    conversationId: body.conversation_id,
    sender: body.sender,
    receivedAt: frame.receivedAt,
  }
}

function normalizePresence(frame: InboundFrame): NormalizedPresence {
  const body = validate(presenceUpdateSchema, frame.payload, 'presence.update')
  return {
    kind: 'presence',
    handle: body.handle,
    status: body.status,
    lastActiveAt: body.last_active_at ?? null,
    customStatus: body.custom_status ?? null,
    receivedAt: frame.receivedAt,
  }
}

function normalizeRateLimitWarning(frame: InboundFrame): NormalizedRateLimitWarning {
  const body = validate(rateLimitWarningSchema, frame.payload, 'rate_limit.warning')
  return {
    kind: 'rate-limit-warning',
    endpoint: body.endpoint ?? null,
    limit: body.limit ?? null,
    remaining: body.remaining ?? null,
    resetAt: body.reset_at ?? null,
    message: body.message ?? null,
    receivedAt: frame.receivedAt,
  }
}

function normalizeGroupInvite(frame: InboundFrame): NormalizedGroupInvite {
  const body = validate(groupInviteReceivedSchema, frame.payload, 'group.invite.received')
  return {
    kind: 'group-invite',
    inviteId: body.id,
    groupId: body.group_id,
    groupName: body.group_name,
    groupDescription: body.group_description ?? null,
    groupAvatarUrl: body.group_avatar_url ?? null,
    groupMemberCount: body.group_member_count,
    inviterHandle: body.inviter_handle,
    createdAt: body.created_at,
    receivedAt: frame.receivedAt,
  }
}

function normalizeGroupDeleted(frame: InboundFrame): NormalizedGroupDeleted {
  const body = validate(groupDeletedSchema, frame.payload, 'group.deleted')
  return {
    kind: 'group-deleted',
    groupId: body.group_id,
    deletedByHandle: body.deleted_by_handle,
    deletedAt: body.deleted_at,
    receivedAt: frame.receivedAt,
  }
}
