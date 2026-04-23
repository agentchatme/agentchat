/**
 * Smoke tests for P1 SDK wiring.
 *
 * Scope:
 *   - `agentchatPlugin` conforms to the ChannelPlugin shape (id/meta/
 *     capabilities/config/configSchema/setup all present & correctly shaped)
 *   - `config.listAccountIds` and `config.resolveAccount` work across the
 *     flat (`channels.agentchat.apiKey`) and namespaced
 *     (`channels.agentchat.accounts.<id>.apiKey`) forms, plus the empty case.
 *   - `setup.applyAccountConfig` writes to the right place for both forms.
 *   - `agentchatChannelEntry` exposes the fields OpenClaw's loader reads.
 *   - `openclaw.plugin.json#configSchema` matches the Zod-derived schema —
 *     protects against drift between manifest and runtime.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  AGENTCHAT_CHANNEL_ID,
  AGENTCHAT_DEFAULT_ACCOUNT_ID,
  agentchatChannelEntry,
  agentchatPlugin,
} from '../src/channel.js'

const VALID_KEY = 'ac_live_' + 'x'.repeat(20)

function cfg(channelSection: unknown): any {
  return { channels: { [AGENTCHAT_CHANNEL_ID]: channelSection } }
}

describe('plugin — shape', () => {
  it('declares required ChannelPlugin fields', () => {
    expect(agentchatPlugin.id).toBe('agentchat')
    expect(agentchatPlugin.meta.label).toBe('AgentChat')
    expect(agentchatPlugin.meta.docsPath).toBe('/channels/agentchat')
    expect(agentchatPlugin.capabilities.chatTypes).toEqual(['direct', 'group'])
    expect(typeof agentchatPlugin.config.listAccountIds).toBe('function')
    expect(typeof agentchatPlugin.config.resolveAccount).toBe('function')
    expect(agentchatPlugin.configSchema).toBeDefined()
    expect(agentchatPlugin.configSchema?.schema).toBeTypeOf('object')
  })

  it('flags outbound capabilities correctly for v1', () => {
    expect(agentchatPlugin.capabilities.media).toBe(true)
    expect(agentchatPlugin.capabilities.reply).toBe(true)
    expect(agentchatPlugin.capabilities.edit).toBe(false)
    expect(agentchatPlugin.capabilities.reactions).toBe(false)
  })

  it('declares reload prefixes so config hot-reload targets our section', () => {
    expect(agentchatPlugin.reload?.configPrefixes).toContain('channels.agentchat.')
  })
})

describe('plugin — config adapter', () => {
  it('returns empty account list when channel section is absent', () => {
    expect(agentchatPlugin.config.listAccountIds({} as any)).toEqual([])
    expect(agentchatPlugin.config.listAccountIds(cfg(undefined))).toEqual([])
  })

  it('treats a flat section as a single default account', () => {
    const ids = agentchatPlugin.config.listAccountIds(cfg({ apiKey: VALID_KEY }))
    expect(ids).toEqual([AGENTCHAT_DEFAULT_ACCOUNT_ID])
  })

  it('lists named accounts from the nested accounts map', () => {
    const ids = agentchatPlugin.config.listAccountIds(
      cfg({ accounts: { primary: { apiKey: VALID_KEY }, staging: { apiKey: VALID_KEY } } }),
    )
    expect(ids.sort()).toEqual(['primary', 'staging'])
  })

  it('resolves a flat default account and parses config', () => {
    const resolved = agentchatPlugin.config.resolveAccount(cfg({ apiKey: VALID_KEY }))
    expect(resolved.accountId).toBe(AGENTCHAT_DEFAULT_ACCOUNT_ID)
    expect(resolved.enabled).toBe(true)
    expect(resolved.configured).toBe(true)
    expect(resolved.config?.apiKey).toBe(VALID_KEY)
    expect(resolved.parseError).toBeNull()
  })

  it('resolves a named account and parses config', () => {
    const resolved = agentchatPlugin.config.resolveAccount(
      cfg({ accounts: { staging: { apiKey: VALID_KEY, apiBase: 'https://staging.agentchat.me' } } }),
      'staging',
    )
    expect(resolved.accountId).toBe('staging')
    expect(resolved.config?.apiBase).toBe('https://staging.agentchat.me')
    expect(resolved.configured).toBe(true)
  })

  it('reports parseError for malformed config instead of throwing', () => {
    const resolved = agentchatPlugin.config.resolveAccount(cfg({ apiKey: 'too-short' }))
    expect(resolved.configured).toBe(false)
    expect(resolved.parseError).toMatch(/too short/)
  })

  it('returns unconfigured for an empty default account', () => {
    const resolved = agentchatPlugin.config.resolveAccount(cfg(undefined))
    expect(resolved.configured).toBe(false)
    expect(resolved.config).toBeNull()
  })

  it('respects explicit enabled=false', () => {
    const resolved = agentchatPlugin.config.resolveAccount(cfg({ apiKey: VALID_KEY, enabled: false }))
    expect(resolved.enabled).toBe(false)
    expect(agentchatPlugin.config.isEnabled?.(resolved, {} as any)).toBe(false)
  })

  it('hasConfiguredState finds key in flat form', () => {
    expect(agentchatPlugin.config.hasConfiguredState?.({ cfg: cfg({ apiKey: VALID_KEY }) })).toBe(true)
  })

  it('hasConfiguredState finds key in any named account', () => {
    expect(
      agentchatPlugin.config.hasConfiguredState?.({
        cfg: cfg({ accounts: { prod: { apiKey: VALID_KEY } } }),
      }),
    ).toBe(true)
  })

  it('hasConfiguredState returns false when only short keys are present', () => {
    expect(
      agentchatPlugin.config.hasConfiguredState?.({ cfg: cfg({ apiKey: 'too-short' }) }),
    ).toBe(false)
  })
})

describe('plugin — setup adapter', () => {
  it('writes apiKey to flat section for the default account when empty', () => {
    const next = agentchatPlugin.setup?.applyAccountConfig({
      cfg: { channels: {} } as any,
      accountId: AGENTCHAT_DEFAULT_ACCOUNT_ID,
      input: { token: VALID_KEY },
    })
    expect(next?.channels?.agentchat?.apiKey).toBe(VALID_KEY)
    expect(next?.channels?.agentchat?.accounts).toBeUndefined()
  })

  it('writes apiKey under accounts.{id} for named accounts', () => {
    const next = agentchatPlugin.setup?.applyAccountConfig({
      cfg: { channels: {} } as any,
      accountId: 'primary',
      input: { token: VALID_KEY, url: 'https://staging.agentchat.me' },
    })
    expect(next?.channels?.agentchat?.accounts?.primary?.apiKey).toBe(VALID_KEY)
    expect(next?.channels?.agentchat?.accounts?.primary?.apiBase).toBe('https://staging.agentchat.me')
  })

  it('validateInput rejects a missing token', () => {
    const err = agentchatPlugin.setup?.validateInput?.({
      cfg: { channels: {} } as any,
      accountId: AGENTCHAT_DEFAULT_ACCOUNT_ID,
      input: {},
    })
    expect(err).toMatch(/apiKey is required/)
  })

  it('validateInput rejects a too-short token', () => {
    const err = agentchatPlugin.setup?.validateInput?.({
      cfg: { channels: {} } as any,
      accountId: AGENTCHAT_DEFAULT_ACCOUNT_ID,
      input: { token: 'short' },
    })
    expect(err).toMatch(/apiKey looks too short/)
  })

  it('validateInput rejects a malformed url', () => {
    const err = agentchatPlugin.setup?.validateInput?.({
      cfg: { channels: {} } as any,
      accountId: AGENTCHAT_DEFAULT_ACCOUNT_ID,
      input: { token: VALID_KEY, url: 'not-a-url' },
    })
    expect(err).toMatch(/not a valid URL/)
  })

  it('validateInput accepts a valid token + https url', () => {
    const err = agentchatPlugin.setup?.validateInput?.({
      cfg: { channels: {} } as any,
      accountId: AGENTCHAT_DEFAULT_ACCOUNT_ID,
      input: { token: VALID_KEY, url: 'https://api.agentchat.me' },
    })
    expect(err).toBeNull()
  })
})

describe('channel entry — shape expected by OpenClaw loader', () => {
  it('exposes id/name/description/configSchema/register/channelPlugin', () => {
    expect(agentchatChannelEntry.id).toBe('agentchat')
    expect(agentchatChannelEntry.name).toBe('AgentChat')
    expect(typeof agentchatChannelEntry.register).toBe('function')
    expect(agentchatChannelEntry.channelPlugin).toBe(agentchatPlugin)
    expect(agentchatChannelEntry.configSchema?.schema).toBeTypeOf('object')
  })
})

describe('manifest sync', () => {
  it('openclaw.plugin.json#configSchema matches the Zod-derived schema', () => {
    const manifestPath = resolve(__dirname, '..', 'openclaw.plugin.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    // The emit script strips top-level `$`-prefixed keys (e.g. `$schema`)
    // from the manifest because Convex rejects them at publish time. Mirror
    // that strip here so the test asserts structural sync, not byte-equality
    // with a field that's deliberately omitted on disk.
    const expected = { ...(agentchatPlugin.configSchema?.schema as Record<string, unknown>) }
    for (const key of Object.keys(expected)) {
      if (key.startsWith('$')) delete expected[key]
    }
    expect(manifest.configSchema).toEqual(expected)
  })

  it('openclaw.plugin.json#uiHints matches the plugin uiHints', () => {
    const manifestPath = resolve(__dirname, '..', 'openclaw.plugin.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    expect(manifest.uiHints).toEqual(agentchatPlugin.configSchema?.uiHints)
  })
})
