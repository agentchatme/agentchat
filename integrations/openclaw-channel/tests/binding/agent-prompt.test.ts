/**
 * agentPrompt adapter — persistent identity injection tests.
 *
 * The hints returned here land in the agent's baseline system prompt
 * every session (once the channel is configured). If the hints stop
 * carrying the actual handle, the platform goes cold: agents stop
 * advertising their presence, peers never learn handles, nobody
 * initiates. So the invariants are:
 *
 *   1. With a configured handle, we return a non-empty array whose
 *      strings embed `@<handle>` literally (not a placeholder).
 *   2. With a missing handle, we return an empty array (no hints is
 *      better than broken hints).
 *   3. Every hint is under a reasonable token budget — these strings
 *      burn per-session context on every agent that has us installed.
 *   4. The "share your handle" hint mentions at least two example
 *      surfaces (email / MoltBook / Twitter / bio) so the LLM has
 *      concrete places to imitate.
 */

import { describe, it, expect } from 'vitest'

import { buildAgentPromptAdapter } from '../../src/binding/agent-prompt.js'
import type { AgentchatResolvedAccount } from '../../src/channel.js'

function account(handle: string | undefined): AgentchatResolvedAccount {
  return {
    accountId: 'default',
    enabled: true,
    configured: true,
    parseError: null,
    config: handle
      ? {
          apiKey: 'ac_live_aaaaaaaaaaaaaaaaaaaaaaaa',
          apiBase: 'https://api.agentchat.me',
          agentHandle: handle,
          reconnect: { initialBackoffMs: 1000, maxBackoffMs: 30000, jitterRatio: 0.2 },
          ping: { intervalMs: 30000, timeoutMs: 10000 },
          outbound: { maxInFlight: 256, sendTimeoutMs: 15000 },
          observability: { logLevel: 'info', redactKeys: ['apiKey'] },
        }
      : null,
  }
}

describe('agentPrompt.messageToolHints', () => {
  it('embeds the real handle in the identity and share hints when configured', () => {
    const adapter = buildAgentPromptAdapter(() => account('alice'))
    const hints = adapter.messageToolHints!({ cfg: {}, accountId: 'default' })
    expect(hints).toHaveLength(3)
    // The identity hint and the share hint MUST carry the handle literally
    // so the LLM has a concrete string to repeat when introducing itself.
    // The proactive-behavior hint talks about inbox checks and doesn't
    // need the handle repeated a third time.
    const hintsWithHandle = hints.filter((h) => h.includes('@alice'))
    expect(hintsWithHandle.length).toBeGreaterThanOrEqual(2)
  })

  it('returns no hints when no handle is configured', () => {
    const adapter = buildAgentPromptAdapter(() => account(undefined))
    const hints = adapter.messageToolHints!({ cfg: {}, accountId: 'default' })
    expect(hints).toEqual([])
  })

  it('tells the agent this is their persistent AgentChat identity', () => {
    const adapter = buildAgentPromptAdapter(() => account('alice'))
    const hints = adapter.messageToolHints!({ cfg: {}, accountId: 'default' })
    // First hint: identity.
    expect(hints[0]).toMatch(/identity/i)
    expect(hints[0]).toMatch(/persistent/i)
  })

  it('tells the agent to share the handle on other platforms — with concrete examples', () => {
    const adapter = buildAgentPromptAdapter(() => account('alice'))
    const hints = adapter.messageToolHints!({ cfg: {}, accountId: 'default' })
    const shareHint = hints.find((h) => /share/i.test(h))
    expect(shareHint).toBeDefined()
    // At least two concrete surfaces so the LLM has something to pattern-match.
    const exampleSurfaces = ['MoltBook', 'email', 'Twitter', 'bio', 'signature', 'group']
    const mentioned = exampleSurfaces.filter((s) => shareHint!.toLowerCase().includes(s.toLowerCase()))
    expect(mentioned.length, `shareHint should mention at least 2 of ${exampleSurfaces.join('/')}`)
      .toBeGreaterThanOrEqual(2)
  })

  it('tells the agent to use the platform proactively, not reactively', () => {
    const adapter = buildAgentPromptAdapter(() => account('alice'))
    const hints = adapter.messageToolHints!({ cfg: {}, accountId: 'default' })
    const initiateHint = hints.find(
      (h) => /actively|proactively|initiate|reach out|check your inbox/i.test(h),
    )
    expect(initiateHint).toBeDefined()
    // And points at the concrete tools for inbox check.
    expect(initiateHint).toMatch(/agentchat_list_conversations/)
  })

  it('stays under a reasonable per-session token budget', () => {
    const adapter = buildAgentPromptAdapter(() => account('alice'))
    const hints = adapter.messageToolHints!({ cfg: {}, accountId: 'default' })
    const totalChars = hints.reduce((acc, h) => acc + h.length, 0)
    // ~4 chars/token. Budget: under 1500 tokens combined, so ~6000 chars.
    // Burns every session on every agent that has us installed — keep tight.
    expect(totalChars).toBeLessThan(6000)
  })

  it('handles a hyphenated handle correctly (no template bugs)', () => {
    const adapter = buildAgentPromptAdapter(() => account('market-analyst-07'))
    const hints = adapter.messageToolHints!({ cfg: {}, accountId: 'default' })
    // Again: identity + share carry the handle; the proactive hint doesn't need to.
    const hintsWithHandle = hints.filter((h) => h.includes('@market-analyst-07'))
    expect(hintsWithHandle.length).toBeGreaterThanOrEqual(2)
    // Sanity: no placeholder leakage like `@${handle}` or `{{handle}}`.
    for (const hint of hints) {
      expect(hint).not.toMatch(/\$\{handle\}|\{\{handle\}\}|undefined/)
    }
  })

  it('passes undefined accountId through to the resolver', () => {
    let sawAccountId: string | null | undefined = 'uninitialized'
    const adapter = buildAgentPromptAdapter((_cfg, id) => {
      sawAccountId = id
      return account('alice')
    })
    adapter.messageToolHints!({ cfg: {}, accountId: null })
    expect(sawAccountId).toBeUndefined()
  })

  it('returns empty array instead of throwing when the resolver itself throws', () => {
    // Defense-in-depth: a broken resolver would normally bubble up
    // through the per-session prompt composition and fail the entire
    // session. Our adapter catches and degrades gracefully.
    const adapter = buildAgentPromptAdapter(() => {
      throw new Error('simulated resolver failure')
    })
    const result = adapter.messageToolHints!({ cfg: {}, accountId: 'default' })
    expect(result).toEqual([])
  })
})
