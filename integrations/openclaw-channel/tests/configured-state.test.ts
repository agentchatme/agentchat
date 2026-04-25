import { describe, it, expect } from 'vitest'
import { hasAgentChatConfiguredState } from '../src/configured-state.js'

describe('hasAgentChatConfiguredState', () => {
  const validKey = 'ac_live_' + 'x'.repeat(20)

  it('rejects undefined config', () => {
    expect(hasAgentChatConfiguredState(undefined)).toBe(false)
  })

  it('rejects empty config', () => {
    expect(hasAgentChatConfiguredState({})).toBe(false)
  })

  it('rejects apiKey-only config (handle missing)', () => {
    expect(hasAgentChatConfiguredState({ apiKey: validKey })).toBe(false)
  })

  it('rejects empty agentHandle even with valid apiKey', () => {
    expect(hasAgentChatConfiguredState({ apiKey: validKey, agentHandle: '' })).toBe(false)
    expect(hasAgentChatConfiguredState({ apiKey: validKey, agentHandle: '   ' })).toBe(false)
  })

  it('rejects short apiKey', () => {
    expect(hasAgentChatConfiguredState({ apiKey: 'too-short', agentHandle: 'alice' })).toBe(false)
  })

  it('rejects non-string apiKey or handle', () => {
    expect(hasAgentChatConfiguredState({ apiKey: 12345, agentHandle: 'alice' } as unknown as { apiKey?: unknown; agentHandle?: unknown })).toBe(false)
    expect(hasAgentChatConfiguredState({ apiKey: validKey, agentHandle: 12345 } as unknown as { apiKey?: unknown; agentHandle?: unknown })).toBe(false)
  })

  it('accepts valid apiKey + handle', () => {
    expect(hasAgentChatConfiguredState({ apiKey: validKey, agentHandle: 'alice' })).toBe(true)
  })
})
