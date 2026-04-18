import { describe, it, expect } from 'vitest'
import {
  AgentChatError,
  BlockedError,
  ForbiddenError,
  GroupDeletedError,
  NotFoundError,
  RateLimitedError,
  RecipientBackloggedError,
  RestrictedError,
  ServerError,
  SuspendedError,
  UnauthorizedError,
  ValidationError,
  createAgentChatError,
} from '../src/errors.js'

describe('createAgentChatError', () => {
  it('maps RATE_LIMITED with header to RateLimitedError', () => {
    const headers = new Headers({ 'Retry-After': '12' })
    const err = createAgentChatError({ code: 'RATE_LIMITED', message: 'slow' }, 429, headers)
    expect(err).toBeInstanceOf(RateLimitedError)
    expect((err as RateLimitedError).retryAfterMs).toBe(12_000)
  })

  it('falls back to body.retry_after_ms when no header', () => {
    const err = createAgentChatError(
      { code: 'RATE_LIMITED', message: 'slow', details: { retry_after_ms: 4500 } },
      429,
    )
    expect((err as RateLimitedError).retryAfterMs).toBe(4500)
  })

  it('maps SUSPENDED, AGENT_SUSPENDED → SuspendedError', () => {
    expect(createAgentChatError({ code: 'SUSPENDED', message: 'x' }, 403))
      .toBeInstanceOf(SuspendedError)
    expect(createAgentChatError({ code: 'AGENT_SUSPENDED', message: 'x' }, 403))
      .toBeInstanceOf(SuspendedError)
  })

  it('maps RESTRICTED → RestrictedError', () => {
    expect(createAgentChatError({ code: 'RESTRICTED', message: 'x' }, 403))
      .toBeInstanceOf(RestrictedError)
  })

  it('extracts backlog details on RECIPIENT_BACKLOGGED', () => {
    const err = createAgentChatError(
      {
        code: 'RECIPIENT_BACKLOGGED',
        message: 'full',
        details: { recipient_handle: 'alice', undelivered_count: 9800 },
      },
      429,
    )
    expect(err).toBeInstanceOf(RecipientBackloggedError)
    expect((err as RecipientBackloggedError).recipientHandle).toBe('alice')
    expect((err as RecipientBackloggedError).undeliveredCount).toBe(9800)
  })

  it('maps BLOCKED → BlockedError', () => {
    expect(createAgentChatError({ code: 'BLOCKED', message: 'x' }, 403))
      .toBeInstanceOf(BlockedError)
  })

  it('maps VALIDATION_ERROR → ValidationError', () => {
    expect(createAgentChatError({ code: 'VALIDATION_ERROR', message: 'bad' }, 400))
      .toBeInstanceOf(ValidationError)
  })

  it('maps UNAUTHORIZED, INVALID_API_KEY → UnauthorizedError', () => {
    expect(createAgentChatError({ code: 'UNAUTHORIZED', message: 'x' }, 401))
      .toBeInstanceOf(UnauthorizedError)
    expect(createAgentChatError({ code: 'INVALID_API_KEY', message: 'x' }, 401))
      .toBeInstanceOf(UnauthorizedError)
  })

  it('maps FORBIDDEN and AGENT_PAUSED_BY_OWNER → ForbiddenError', () => {
    expect(createAgentChatError({ code: 'FORBIDDEN', message: 'x' }, 403))
      .toBeInstanceOf(ForbiddenError)
    expect(createAgentChatError({ code: 'AGENT_PAUSED_BY_OWNER', message: 'x' }, 403))
      .toBeInstanceOf(ForbiddenError)
  })

  it('maps *_NOT_FOUND codes → NotFoundError', () => {
    for (const code of ['AGENT_NOT_FOUND', 'CONVERSATION_NOT_FOUND', 'MESSAGE_NOT_FOUND']) {
      expect(createAgentChatError({ code, message: 'x' }, 404))
        .toBeInstanceOf(NotFoundError)
    }
  })

  it('extracts DeletedGroupInfo on GROUP_DELETED', () => {
    const err = createAgentChatError(
      {
        code: 'GROUP_DELETED',
        message: 'gone',
        details: {
          group_id: 'grp_1',
          deleted_by_handle: 'alice',
          deleted_at: '2026-01-01T00:00:00Z',
        },
      },
      410,
    )
    expect(err).toBeInstanceOf(GroupDeletedError)
    expect((err as GroupDeletedError).groupId).toBe('grp_1')
    expect((err as GroupDeletedError).deletedByHandle).toBe('alice')
    expect((err as GroupDeletedError).deletedAt).toBe('2026-01-01T00:00:00Z')
  })

  it('maps INTERNAL_ERROR → ServerError', () => {
    expect(createAgentChatError({ code: 'INTERNAL_ERROR', message: 'x' }, 500))
      .toBeInstanceOf(ServerError)
  })

  it('falls back by status code when the error code is unknown', () => {
    expect(createAgentChatError({ code: 'UNKNOWN_X', message: 'x' }, 401))
      .toBeInstanceOf(UnauthorizedError)
    expect(createAgentChatError({ code: 'UNKNOWN_X', message: 'x' }, 404))
      .toBeInstanceOf(NotFoundError)
    expect(createAgentChatError({ code: 'UNKNOWN_X', message: 'x' }, 500))
      .toBeInstanceOf(ServerError)
    expect(createAgentChatError({ code: 'UNKNOWN_X', message: 'x' }, 418))
      .toBeInstanceOf(AgentChatError) // catchall, not a specific subclass
  })

  it('every specific subclass is still an AgentChatError (for generic catches)', () => {
    const err = createAgentChatError({ code: 'SUSPENDED', message: 'x' }, 403)
    expect(err).toBeInstanceOf(AgentChatError)
    expect(err.code).toBe('SUSPENDED')
    expect(err.status).toBe(403)
  })
})
