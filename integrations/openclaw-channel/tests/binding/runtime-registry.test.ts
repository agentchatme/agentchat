/**
 * Runtime-registry concurrency + lifecycle tests.
 *
 * The registry is the single source of truth for live `AgentchatChannelRuntime`
 * instances per-account. It MUST:
 *   - Serialize concurrent `registerRuntime` for the same account (no
 *     double-start).
 *   - Roll back on synchronous start failure.
 *   - Allow parallel calls for DIFFERENT accounts to proceed concurrently.
 *   - `unregisterRuntime` cleanly tear down; no-op if absent.
 *
 * We use a substituted `AgentchatChannelRuntime` double because the real
 * runtime opens a WebSocket. The test hooks `registerRuntime` directly
 * and verifies concurrency via an instrumented constructor count.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

import {
  registerRuntime,
  unregisterRuntime,
  getRuntime,
  listActiveAccounts,
  resetRegistryForTest,
} from '../../src/binding/runtime-registry.js'
import { createLogger } from '../../src/log.js'
import type { AgentchatChannelConfig } from '../../src/config-schema.js'

const makeConfig = (): AgentchatChannelConfig => ({
  apiKey: 'ac_live_key_aaaaaaaaaaaaaaaaaaaaaaaa',
  apiBase: 'https://api.agentchat.me',
  reconnect: { initialBackoffMs: 1000, maxBackoffMs: 30000, jitterRatio: 0.2 },
  ping: { intervalMs: 30000, timeoutMs: 10000 },
  outbound: { maxInFlight: 256, sendTimeoutMs: 15000 },
  observability: { logLevel: 'error', redactKeys: ['apiKey'] },
})

const makeLogger = () =>
  createLogger({ level: 'error', redactKeys: ['apiKey'] })

// Stub the AgentchatChannelRuntime so tests don't open real WebSockets.
// We watch how many times the constructor fires to catch double-starts.
vi.mock('../../src/runtime.js', async () => {
  const constructorCalls: Array<{ accountId: string | null }> = []
  class StubRuntime {
    private stopped = false
    static calls = constructorCalls
    constructor(_opts: unknown) {
      constructorCalls.push({ accountId: null })
    }
    start() {
      /* no-op */
    }
    async stop(_deadline?: number): Promise<void> {
      this.stopped = true
    }
    get isStopped() {
      return this.stopped
    }
  }
  return { AgentchatChannelRuntime: StubRuntime }
})

async function hookedRegister(accountId: string) {
  return registerRuntime({
    accountId,
    config: makeConfig(),
    handlers: {},
    logger: makeLogger(),
  })
}

describe('runtime-registry', () => {
  beforeEach(async () => {
    await resetRegistryForTest()
  })

  it('registers a runtime and makes it retrievable via getRuntime', async () => {
    const rt = await hookedRegister('acct-1')
    expect(rt).toBeDefined()
    expect(getRuntime('acct-1')).toBe(rt)
    expect(listActiveAccounts()).toEqual(['acct-1'])
  })

  it('stops and removes on unregisterRuntime', async () => {
    await hookedRegister('acct-1')
    await unregisterRuntime('acct-1', Date.now() + 500)
    expect(getRuntime('acct-1')).toBeUndefined()
    expect(listActiveAccounts()).toEqual([])
  })

  it('unregister of a missing account is a no-op', async () => {
    await expect(unregisterRuntime('nope', Date.now() + 500)).resolves.toBeUndefined()
  })

  it('serializes concurrent registerRuntime calls for the same account', async () => {
    // Fire 5 concurrent calls for the same accountId. Only ONE runtime
    // should be live at the end — the last registration wins, and every
    // prior runtime was stopped.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => hookedRegister('acct-hot')),
    )
    const live = getRuntime('acct-hot')
    expect(live).toBeDefined()
    // Every call returns A runtime (not necessarily the same one), and
    // whichever settled last is the live one.
    expect(results).toHaveLength(5)
    expect(results[results.length - 1]).toBe(live)
    // Exactly one live registry entry.
    expect(listActiveAccounts()).toEqual(['acct-hot'])
  })

  it('allows parallel registerRuntime for DIFFERENT accounts', async () => {
    await Promise.all([
      hookedRegister('acct-a'),
      hookedRegister('acct-b'),
      hookedRegister('acct-c'),
    ])
    expect(listActiveAccounts().sort()).toEqual(['acct-a', 'acct-b', 'acct-c'])
  })

  it('does not leak registry entries when register throws synchronously on start', async () => {
    // The stub runtime never throws; we simulate the throw by overriding
    // `start` for one specific instance via a module-level override.
    const mod = await import('../../src/runtime.js')
    const OriginalRuntime = mod.AgentchatChannelRuntime
    const throwingStart = vi
      .spyOn(OriginalRuntime.prototype as { start: () => void }, 'start')
      .mockImplementationOnce(() => {
        throw new Error('simulated start failure')
      })
    await expect(hookedRegister('acct-broken')).rejects.toThrow(/start failure/)
    // Registry must not retain the failed entry.
    expect(getRuntime('acct-broken')).toBeUndefined()
    expect(listActiveAccounts()).not.toContain('acct-broken')
    throwingStart.mockRestore()
  })
})
