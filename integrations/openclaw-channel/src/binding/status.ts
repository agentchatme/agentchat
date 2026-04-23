/**
 * ChannelStatusAdapter — account health + configured-state probe.
 *
 * `probeAccount` hits `/v1/agents/me` with a short timeout and reports
 * whether the configured key still authenticates and whether the account
 * is active / restricted / suspended. The gateway uses this to surface a
 * red/yellow/green status in `openclaw channels status` and to decide when
 * to page an operator for stuck accounts.
 */

import type {
  ChannelStatusAdapter,
  ChannelCapabilitiesDisplayLine,
} from './openclaw-types.js'

import type { AgentchatResolvedAccount } from '../channel.js'
import { getClient } from './sdk-client.js'

export type AgentchatProbeResult = {
  readonly ok: boolean
  readonly handle?: string
  readonly status?: 'active' | 'restricted' | 'suspended' | 'deleted'
  readonly pausedByOwner?: 'none' | 'send' | 'full'
  readonly error?: string
}

/** Probe timeout bounds. OpenClaw can pass arbitrary values; we clamp
 * both ends so a zero-timeout doesn't race and a sky-high one doesn't
 * hold the status pane hostage for a minute on a flaky network. */
const PROBE_MIN_MS = 1_000
const PROBE_MAX_MS = 10_000

export const agentchatStatusAdapter: ChannelStatusAdapter<AgentchatResolvedAccount, AgentchatProbeResult> = {
  async probeAccount({ account, timeoutMs }) {
    if (!account.config) {
      return { ok: false, error: 'missing channels.agentchat configuration' }
    }
    const client = getClient({ accountId: account.accountId, config: account.config })
    const clampedTimeout = Math.min(PROBE_MAX_MS, Math.max(PROBE_MIN_MS, timeoutMs))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), clampedTimeout)
    try {
      const me = await client.getMe({ signal: controller.signal })
      clearTimeout(timer)
      return {
        ok: me.status === 'active',
        handle: me.handle,
        status: me.status,
        pausedByOwner: me.paused_by_owner ?? 'none',
      }
    } catch (err) {
      clearTimeout(timer)
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  },

  formatCapabilitiesProbe({ probe }) {
    const lines: ChannelCapabilitiesDisplayLine[] = []
    if (!probe.ok) {
      lines.push({
        text: probe.error ?? 'not authenticated',
        tone: 'error',
      })
      return lines
    }
    lines.push({
      text: `authenticated as @${probe.handle}`,
      tone: 'success',
    })
    if (probe.status && probe.status !== 'active') {
      lines.push({
        text: `account status: ${probe.status}`,
        tone: probe.status === 'restricted' ? 'warn' : 'error',
      })
    }
    if (probe.pausedByOwner && probe.pausedByOwner !== 'none') {
      lines.push({
        text: `owner paused this account (${probe.pausedByOwner})`,
        tone: 'warn',
      })
    }
    return lines
  },

  resolveAccountState({ account, configured, enabled }) {
    if (!enabled) return 'disabled'
    if (!configured) return 'not configured'
    if (account.configured) return 'linked'
    return 'not linked'
  },
}
