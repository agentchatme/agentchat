/**
 * Tests for the inbound normalizer.
 *
 * Covers:
 *   - Shape translation: each server event maps to the right Normalized
 *     variant with the right fields snake→camel renamed.
 *   - Conversation-kind inference from `dir_*`/`grp_*` prefix.
 *   - Validation failures produce AgentChatChannelError with class `validation`.
 *   - Unknown event types pass through as `NormalizedUnknown`.
 */

import { describe, it, expect } from 'vitest'
import {
  classifyConversationId,
  normalizeInbound,
  type NormalizedMessage,
  type NormalizedReadReceipt,
  type NormalizedTyping,
  type NormalizedPresence,
  type NormalizedRateLimitWarning,
  type NormalizedGroupInvite,
  type NormalizedGroupDeleted,
  type NormalizedUnknown,
} from '../src/inbound.js'
import type { InboundFrame } from '../src/ws-client.js'
import { AgentChatChannelError } from '../src/errors.js'

function frame(type: string, payload: Record<string, unknown>): InboundFrame {
  return { type, payload, receivedAt: 1_700_000_000_000, raw: { type, payload } }
}

describe('classifyConversationId', () => {
  it('returns direct for conv_ prefix (production DM ids)', () => {
    expect(classifyConversationId('conv_d6YAy98A4PTqSZZP')).toBe('direct')
  })
  it('accepts legacy dir_ prefix as direct', () => {
    expect(classifyConversationId('dir_abc')).toBe('direct')
  })
  it('returns group for grp_ prefix', () => {
    expect(classifyConversationId('grp_xyz')).toBe('group')
  })
  it('returns null for unrecognized prefix', () => {
    expect(classifyConversationId('chat_123')).toBeNull()
  })
})

describe('normalizeInbound — message.new', () => {
  const base = {
    id: 'msg_1',
    conversation_id: 'dir_alice',
    sender: 'alice',
    client_msg_id: 'cli_1',
    seq: 42,
    type: 'text',
    content: { text: 'hi' },
    metadata: { source: 'slack' },
    status: 'stored',
    created_at: '2026-04-19T00:00:00Z',
    delivered_at: null,
    read_at: null,
  }

  it('maps all fields and classifies as direct', () => {
    const out = normalizeInbound(frame('message.new', base)) as NormalizedMessage
    expect(out.kind).toBe('message')
    expect(out.conversationKind).toBe('direct')
    expect(out.messageId).toBe('msg_1')
    expect(out.clientMsgId).toBe('cli_1')
    expect(out.sender).toBe('alice')
    expect(out.seq).toBe(42)
    expect(out.messageType).toBe('text')
    expect(out.content.text).toBe('hi')
    expect(out.metadata).toEqual({ source: 'slack' })
    expect(out.status).toBe('stored')
    expect(out.receivedAt).toBe(1_700_000_000_000)
  })

  it('classifies as group for grp_ prefix', () => {
    const out = normalizeInbound(
      frame('message.new', { ...base, conversation_id: 'grp_team' }),
    ) as NormalizedMessage
    expect(out.conversationKind).toBe('group')
  })

  it('preserves structured data payload', () => {
    const out = normalizeInbound(
      frame('message.new', {
        ...base,
        type: 'structured',
        content: { data: { action: 'review', target: 'pr_42' } },
      }),
    ) as NormalizedMessage
    expect(out.content.data).toEqual({ action: 'review', target: 'pr_42' })
    expect(out.content.text).toBeUndefined()
  })

  it('preserves attachment_id as attachmentId', () => {
    const out = normalizeInbound(
      frame('message.new', {
        ...base,
        type: 'file',
        content: { attachment_id: 'att_xyz' },
      }),
    ) as NormalizedMessage
    expect(out.content.attachmentId).toBe('att_xyz')
  })

  it('throws validation error on missing required field', () => {
    expect(() =>
      normalizeInbound(frame('message.new', { ...base, id: undefined })),
    ).toThrow(AgentChatChannelError)
  })

  it('throws validation error on unknown status enum', () => {
    expect(() =>
      normalizeInbound(frame('message.new', { ...base, status: 'fishy' })),
    ).toThrow(/status/)
  })

  it('throws validation error on unknown conversation prefix', () => {
    try {
      normalizeInbound(frame('message.new', { ...base, conversation_id: 'zzz_1' }))
      expect.fail('should throw')
    } catch (e) {
      expect(e).toBeInstanceOf(AgentChatChannelError)
      expect((e as AgentChatChannelError).class_).toBe('validation')
    }
  })
})

describe('normalizeInbound — message.read', () => {
  it('normalizes read receipt', () => {
    const out = normalizeInbound(
      frame('message.read', {
        conversation_id: 'dir_bob',
        through_seq: 100,
        reader: 'bob',
        at: '2026-04-19T00:00:00Z',
      }),
    ) as NormalizedReadReceipt
    expect(out.kind).toBe('read-receipt')
    expect(out.throughSeq).toBe(100)
    expect(out.reader).toBe('bob')
    expect(out.conversationKind).toBe('direct')
  })

  it('allows missing at field (server may omit it)', () => {
    const out = normalizeInbound(
      frame('message.read', {
        conversation_id: 'grp_team',
        through_seq: 5,
        reader: 'charlie',
      }),
    ) as NormalizedReadReceipt
    expect(out.at).toBeNull()
  })
})

describe('normalizeInbound — typing', () => {
  it('maps typing.start', () => {
    const out = normalizeInbound(
      frame('typing.start', { conversation_id: 'dir_alice', sender: 'alice' }),
    ) as NormalizedTyping
    expect(out.kind).toBe('typing')
    expect(out.action).toBe('start')
    expect(out.sender).toBe('alice')
  })

  it('maps typing.stop', () => {
    const out = normalizeInbound(
      frame('typing.stop', { conversation_id: 'dir_alice', sender: 'alice' }),
    ) as NormalizedTyping
    expect(out.action).toBe('stop')
  })
})

describe('normalizeInbound — presence', () => {
  it('maps presence update with optional fields', () => {
    const out = normalizeInbound(
      frame('presence.update', {
        handle: 'alice',
        status: 'away',
        last_active_at: '2026-04-19T00:00:00Z',
        custom_status: 'lunch',
      }),
    ) as NormalizedPresence
    expect(out.kind).toBe('presence')
    expect(out.handle).toBe('alice')
    expect(out.status).toBe('away')
    expect(out.customStatus).toBe('lunch')
  })

  it('coerces missing optional fields to null', () => {
    const out = normalizeInbound(
      frame('presence.update', { handle: 'x', status: 'online' }),
    ) as NormalizedPresence
    expect(out.lastActiveAt).toBeNull()
    expect(out.customStatus).toBeNull()
  })
})

describe('normalizeInbound — rate_limit.warning', () => {
  it('coerces all to null when server omits optional fields', () => {
    const out = normalizeInbound(frame('rate_limit.warning', {})) as NormalizedRateLimitWarning
    expect(out.kind).toBe('rate-limit-warning')
    expect(out.endpoint).toBeNull()
    expect(out.remaining).toBeNull()
  })

  it('maps fields when present', () => {
    const out = normalizeInbound(
      frame('rate_limit.warning', {
        endpoint: '/v1/messages',
        limit: 60,
        remaining: 5,
        reset_at: '2026-04-19T00:01:00Z',
        message: 'approaching limit',
      }),
    ) as NormalizedRateLimitWarning
    expect(out.endpoint).toBe('/v1/messages')
    expect(out.limit).toBe(60)
    expect(out.remaining).toBe(5)
  })
})

describe('normalizeInbound — group events', () => {
  it('normalizes group.invite.received', () => {
    const out = normalizeInbound(
      frame('group.invite.received', {
        id: 'inv_1',
        group_id: 'grp_team',
        group_name: 'Team',
        group_description: null,
        group_avatar_url: null,
        group_member_count: 5,
        inviter_handle: 'alice',
        created_at: '2026-04-19T00:00:00Z',
      }),
    ) as NormalizedGroupInvite
    expect(out.kind).toBe('group-invite')
    expect(out.inviteId).toBe('inv_1')
    expect(out.inviterHandle).toBe('alice')
  })

  it('normalizes group.deleted', () => {
    const out = normalizeInbound(
      frame('group.deleted', {
        group_id: 'grp_x',
        deleted_by_handle: 'charlie',
        deleted_at: '2026-04-19T00:00:00Z',
      }),
    ) as NormalizedGroupDeleted
    expect(out.kind).toBe('group-deleted')
    expect(out.groupId).toBe('grp_x')
  })
})

describe('normalizeInbound — unknown event', () => {
  it('passes through with full payload', () => {
    const out = normalizeInbound(
      frame('future.event.v2', { foo: 'bar', nested: { x: 1 } }),
    ) as NormalizedUnknown
    expect(out.kind).toBe('unknown')
    expect(out.type).toBe('future.event.v2')
    expect(out.payload).toEqual({ foo: 'bar', nested: { x: 1 } })
  })
})
