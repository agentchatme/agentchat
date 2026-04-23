/**
 * ChannelMessagingAdapter unit tests.
 *
 * Covers:
 *   - Handle normalization (@alice → alice, trim, lowercase)
 *   - Conversation-id passthrough (conv_*, grp_*, dir_*)
 *   - Empty input yields `undefined` rather than ''
 *   - Chat-type inference from id prefix (direct vs group)
 */

import { describe, it, expect } from 'vitest'

import {
  normalizeAgentchatTarget,
  inferAgentchatTargetChatType,
  agentchatMessagingAdapter,
} from '../../src/binding/messaging.js'

describe('normalizeAgentchatTarget', () => {
  it('strips a leading @ and lowercases', () => {
    expect(normalizeAgentchatTarget('@Alice')).toBe('alice')
    expect(normalizeAgentchatTarget('Alice')).toBe('alice')
    expect(normalizeAgentchatTarget('ALICE')).toBe('alice')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeAgentchatTarget('   alice   ')).toBe('alice')
    expect(normalizeAgentchatTarget('\t@alice\n')).toBe('alice')
  })

  it('returns undefined for empty or whitespace-only input', () => {
    expect(normalizeAgentchatTarget('')).toBeUndefined()
    expect(normalizeAgentchatTarget('   ')).toBeUndefined()
    expect(normalizeAgentchatTarget('\t\n')).toBeUndefined()
  })

  it('passes conversation ids through verbatim (no case change, no @ strip)', () => {
    expect(normalizeAgentchatTarget('conv_abc123')).toBe('conv_abc123')
    expect(normalizeAgentchatTarget('grp_XYZ')).toBe('grp_XYZ')
    expect(normalizeAgentchatTarget('dir_legacy')).toBe('dir_legacy')
  })

  it('handles hyphenated handles as expected', () => {
    expect(normalizeAgentchatTarget('@market-analyst-7')).toBe('market-analyst-7')
  })
})

describe('inferAgentchatTargetChatType', () => {
  it('returns "group" for grp_ prefix', () => {
    expect(inferAgentchatTargetChatType('grp_abc')).toBe('group')
  })

  it('returns "direct" for conv_ and dir_ prefixes', () => {
    expect(inferAgentchatTargetChatType('conv_abc')).toBe('direct')
    expect(inferAgentchatTargetChatType('dir_abc')).toBe('direct')
  })

  it('returns undefined for bare handles (ambiguous until resolver runs)', () => {
    expect(inferAgentchatTargetChatType('alice')).toBeUndefined()
    expect(inferAgentchatTargetChatType('@alice')).toBeUndefined()
  })
})

describe('agentchatMessagingAdapter', () => {
  it('exposes normalizeTarget and inferTargetChatType hooks', () => {
    expect(typeof agentchatMessagingAdapter.normalizeTarget).toBe('function')
    expect(typeof agentchatMessagingAdapter.inferTargetChatType).toBe('function')
  })

  it('inferTargetChatType takes a params object and returns the inferred kind', () => {
    expect(agentchatMessagingAdapter.inferTargetChatType!({ to: 'grp_abc' })).toBe('group')
    expect(agentchatMessagingAdapter.inferTargetChatType!({ to: 'conv_abc' })).toBe('direct')
    expect(agentchatMessagingAdapter.inferTargetChatType!({ to: 'alice' })).toBeUndefined()
  })
})
