/**
 * AgentChat channel plugin — entry point.
 *
 * Wires the real OpenClaw SDK contracts — builds a
 * `ChannelPlugin<AgentchatResolvedAccount>` with id / meta / capabilities /
 * config-adapter / config-schema / setup + setupWizard, and wraps it via
 * `defineChannelPluginEntry(...)` for OpenClaw's extension loader.
 *
 * Config adapter supports both:
 *   - single-account flat form: `channels.agentchat.{ apiKey, apiBase, ... }`
 *   - multi-account form:       `channels.agentchat.accounts.<id>.{ apiKey, ... }`
 *
 * Loaded by OpenClaw via `package.json`'s `openclaw.extensions` entry.
 */

import {
  buildChannelConfigSchema,
  defineChannelPluginEntry,
  type ChannelConfigUiHint,
  type ChannelPlugin,
} from 'openclaw/plugin-sdk/channel-core'

import {
  AGENTCHAT_CHANNEL_ID,
  AGENTCHAT_DEFAULT_ACCOUNT_ID,
  MIN_API_KEY_LENGTH,
  applyAgentchatAccountPatch,
  isApiKeyPresent,
  readAccountRaw,
  readChannelSection,
  splitEnabledFromRaw,
} from './channel-account.js'
import { agentchatSetupWizard } from './channel.wizard.js'
import {
  agentchatChannelConfigSchema,
  parseChannelConfig,
  type AgentchatChannelConfig,
} from './config-schema.js'
import { validateApiKey } from './setup-client.js'

export {
  AGENTCHAT_CHANNEL_ID,
  AGENTCHAT_DEFAULT_ACCOUNT_ID,
  MIN_API_KEY_LENGTH,
  applyAgentchatAccountPatch,
  isApiKeyPresent,
  readAgentchatConfigField,
} from './channel-account.js'

export interface AgentchatResolvedAccount {
  accountId: string
  enabled: boolean
  configured: boolean
  config: AgentchatChannelConfig | null
  parseError: string | null
}

const uiHints: Record<string, ChannelConfigUiHint> = {
  apiKey: {
    label: 'AgentChat API key',
    placeholder: 'ac_live_...',
    sensitive: true,
    help: 'The setup wizard registers you via email OTP and mints a key — or paste an existing ac_live_… key.',
  },
  apiBase: {
    label: 'API base URL',
    placeholder: 'https://api.agentchat.me',
    help: 'Override only when targeting a self-hosted AgentChat instance.',
    advanced: true,
  },
  agentHandle: {
    label: 'Agent handle',
    placeholder: 'my-agent',
    help: '3–30 chars, lowercase letters/digits/hyphens; must start with a letter.',
  },
  reconnect: { label: 'Reconnect backoff', advanced: true },
  ping: { label: 'WebSocket ping cadence', advanced: true },
  outbound: { label: 'Outbound send tuning', advanced: true },
  observability: { label: 'Logs & metrics', advanced: true },
}

export const agentchatPlugin: ChannelPlugin<AgentchatResolvedAccount> = {
  id: AGENTCHAT_CHANNEL_ID,

  meta: {
    id: AGENTCHAT_CHANNEL_ID,
    label: 'AgentChat',
    selectionLabel: 'AgentChat (messaging platform for agents)',
    detailLabel: 'AgentChat',
    docsPath: '/channels/agentchat',
    docsLabel: 'agentchat',
    blurb:
      'connect your agent to the AgentChat messaging platform — handles, contacts, groups, presence, attachments.',
    systemImage: 'message',
    markdownCapable: true,
    order: 100,
  },

  capabilities: {
    chatTypes: ['direct', 'group'],
    media: true,
    reactions: false,
    edit: false,
    unsend: true,
    reply: true,
    threads: false,
    nativeCommands: false,
  },

  reload: {
    configPrefixes: [`channels.${AGENTCHAT_CHANNEL_ID}.`],
  },

  configSchema: buildChannelConfigSchema(agentchatChannelConfigSchema, { uiHints }),

  setupWizard: agentchatSetupWizard,

  config: {
    listAccountIds(cfg) {
      const section = readChannelSection(cfg)
      if (!section) return []
      const { accounts } = section
      if (accounts && typeof accounts === 'object' && !Array.isArray(accounts)) {
        const ids = Object.keys(accounts as Record<string, unknown>)
        if (ids.length > 0) return ids
      }
      const hasFlatFields =
        typeof section.apiKey === 'string' ||
        typeof section.apiBase === 'string' ||
        typeof section.agentHandle === 'string'
      return hasFlatFields ? [AGENTCHAT_DEFAULT_ACCOUNT_ID] : []
    },

    resolveAccount(cfg, accountId) {
      const id = accountId ?? AGENTCHAT_DEFAULT_ACCOUNT_ID
      const section = readChannelSection(cfg)
      const raw = readAccountRaw(section, id)
      const { enabled, forParse } = splitEnabledFromRaw(raw)
      let config: AgentchatChannelConfig | null = null
      let parseError: string | null = null
      if (forParse && Object.keys(forParse).length > 0) {
        try {
          config = parseChannelConfig(forParse)
        } catch (e) {
          parseError = e instanceof Error ? e.message : String(e)
        }
      }
      const configured = Boolean(config && isApiKeyPresent(config.apiKey))
      return { accountId: id, enabled, configured, config, parseError }
    },

    defaultAccountId() {
      return AGENTCHAT_DEFAULT_ACCOUNT_ID
    },

    isEnabled(account) {
      return account.enabled
    },

    disabledReason(account) {
      return account.enabled ? '' : 'channel disabled via channels.agentchat.enabled=false'
    },

    isConfigured(account) {
      return account.configured
    },

    unconfiguredReason(account) {
      if (account.parseError) return `config invalid: ${account.parseError}`
      if (!account.config) return 'missing channels.agentchat configuration'
      if (!isApiKeyPresent(account.config.apiKey)) return 'missing or too-short channels.agentchat.apiKey'
      return ''
    },

    hasConfiguredState({ cfg }) {
      const section = readChannelSection(cfg)
      if (!section) return false
      const { accounts } = section
      if (accounts && typeof accounts === 'object' && !Array.isArray(accounts)) {
        for (const entry of Object.values(accounts as Record<string, unknown>)) {
          if (entry && typeof entry === 'object') {
            const candidate = (entry as Record<string, unknown>).apiKey
            if (isApiKeyPresent(candidate)) return true
          }
        }
      }
      return isApiKeyPresent(section.apiKey)
    },

    describeAccount(account) {
      return {
        accountId: account.accountId,
        enabled: account.enabled,
        configured: account.configured,
        linked: account.configured,
      }
    },
  },

  setup: {
    /**
     * Pre-write gate: cheap, sync check that the caller supplied an API key
     * that's at least plausibly shaped. Real authentication happens in
     * `afterAccountConfigWritten` via a live /agents/me probe.
     */
    validateInput({ input }) {
      if (typeof input.token !== 'string' || input.token.trim().length === 0) {
        return 'apiKey is required — pass via --token or run the register flow'
      }
      if (input.token.length < MIN_API_KEY_LENGTH) {
        return `apiKey looks too short (got ${input.token.length} chars, expect ≥${MIN_API_KEY_LENGTH})`
      }
      if (typeof input.url === 'string' && input.url.length > 0) {
        try {
          const parsed = new URL(input.url)
          if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
            return 'apiBase must be http(s) — e.g. https://api.agentchat.me'
          }
        } catch {
          return 'apiBase is not a valid URL'
        }
      }
      return null
    },

    applyAccountConfig({ cfg, accountId, input }) {
      const patch: Record<string, unknown> = {}
      if (typeof input.token === 'string' && input.token.length > 0) patch.apiKey = input.token
      if (typeof input.url === 'string' && input.url.length > 0) patch.apiBase = input.url
      return applyAgentchatAccountPatch(cfg, accountId, patch)
    },

    /**
     * Post-write probe: call `GET /v1/agents/me` with the key we just wrote
     * so the operator sees a clear "✓ authenticated as @handle" on success
     * — or a specific failure reason (invalid, revoked, unreachable) they
     * can act on *before* the runtime starts flapping reconnects in prod.
     *
     * Never throws: setup-time UX is "warn and proceed". If the probe can't
     * reach the API (airgapped CI, corp proxy during first boot), we still
     * want the config written so the user can retry without reconfiguring.
     */
    async afterAccountConfigWritten({ cfg, accountId, input, runtime }) {
      const apiKey = typeof input.token === 'string' ? input.token : undefined
      if (!apiKey) return
      const apiBase = typeof input.url === 'string' && input.url.length > 0 ? input.url : undefined
      void cfg
      const logger = (runtime as { logger?: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void } } | undefined)?.logger
      try {
        const result = await validateApiKey(apiKey, { apiBase })
        if (result.ok) {
          logger?.info?.(
            `[agentchat:${accountId}] authenticated as @${result.agent.handle} (${result.agent.email})`,
          )
        } else {
          logger?.warn?.(
            `[agentchat:${accountId}] api key did not pass live check (${result.reason}): ${result.message}`,
          )
        }
      } catch (err) {
        logger?.warn?.(
          `[agentchat:${accountId}] live key validation failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    },
  },
}

/**
 * Canonical channel-entry descriptor consumed by OpenClaw's extension loader.
 * Exported as `default` because `openclaw.extensions` in package.json points to
 * this module and the loader reads the default export.
 *
 * The explicit `ReturnType<...>` annotation pins the emitted `.d.ts` to the
 * function signature instead of the structural shape — otherwise the inferred
 * type references `ChannelConfigSchema` through a non-exported path and TS
 * fails with TS2742 ("cannot be named without a reference to ...").
 */
export const agentchatChannelEntry: ReturnType<
  typeof defineChannelPluginEntry<typeof agentchatPlugin>
> = defineChannelPluginEntry({
  id: AGENTCHAT_CHANNEL_ID,
  name: 'AgentChat',
  description: 'Connect OpenClaw agents to the AgentChat messaging platform.',
  plugin: agentchatPlugin,
})

export default agentchatChannelEntry

export { parseChannelConfig }
export type { AgentchatChannelConfig }
