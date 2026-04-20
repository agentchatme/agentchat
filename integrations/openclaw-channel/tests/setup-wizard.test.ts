/**
 * Tests for the setup wizard.
 *
 * The WizardPrompter is replaced by a `scriptedPrompter` that consumes an
 * ordered list of expected prompts (`note`, `select`, `text`, `confirm`,
 * `progress`) and returns scripted values. Any deviation (wrong prompt kind,
 * scripted value rejected by the prompt's `validate`, surplus or missing
 * steps) fails the test — so the wizard's control flow is pinned end-to-end.
 *
 * The setup-client module is stubbed via `vi.mock` so every server
 * response shape is under test control.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/setup-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/setup-client.js')>()
  return {
    ...actual,
    validateApiKey: vi.fn(),
    registerAgentStart: vi.fn(),
    registerAgentVerify: vi.fn(),
  }
})

import {
  registerAgentStart,
  registerAgentVerify,
  validateApiKey,
} from '../src/setup-client.js'
import { agentchatSetupWizard, __testables } from '../src/setup-wizard.js'

const { readAccountApiKey, writeAccountPatch } = __testables

type Scripted =
  | { kind: 'intro' }
  | { kind: 'outro' }
  | { kind: 'note'; contains?: string }
  | { kind: 'text'; contains?: string; value: string }
  | { kind: 'select'; contains?: string; value: unknown }
  | { kind: 'confirm'; contains?: string; value: boolean }
  | { kind: 'progress' }

function scripted(steps: Scripted[]) {
  const queue = [...steps]
  const consumed: Scripted[] = []
  const take = <K extends Scripted['kind']>(
    expected: K,
    actualMessage: string,
  ): Extract<Scripted, { kind: K }> => {
    const head = queue.shift()
    if (!head) {
      throw new Error(
        `Wizard asked for ${expected} ("${actualMessage}") but the script is exhausted after ${consumed.length} steps`,
      )
    }
    if (head.kind !== expected) {
      throw new Error(
        `Wizard asked for ${expected} ("${actualMessage}"); script expected ${head.kind}`,
      )
    }
    if ('contains' in head && head.contains && !actualMessage.includes(head.contains)) {
      throw new Error(
        `Wizard asked ${expected} with message "${actualMessage}"; script expected contains "${head.contains}"`,
      )
    }
    consumed.push(head)
    return head as Extract<Scripted, { kind: K }>
  }
  const prompter = {
    intro: async () => {
      take('intro', '')
    },
    outro: async () => {
      take('outro', '')
    },
    note: async (message: string, title?: string) => {
      // Match against title + body so tests can assert on either the
      // short title ("Code rejected") or substrings of the body.
      take('note', `${title ?? ''}\n${message}`)
    },
    text: async (params: {
      message: string
      validate?: (v: string) => string | undefined
    }) => {
      const entry = take('text', params.message)
      if (params.validate) {
        const err = params.validate(entry.value)
        if (err)
          throw new Error(
            `scripted value "${entry.value}" rejected by validate for "${params.message}": ${err}`,
          )
      }
      return entry.value
    },
    select: async (params: { message: string }) => {
      const entry = take('select', params.message)
      return entry.value as never
    },
    confirm: async (params: { message: string }) => {
      const entry = take('confirm', params.message)
      return entry.value
    },
    multiselect: async () => {
      throw new Error('multiselect not mocked in wizard tests')
    },
    progress: (_label: string) => {
      // progress start + stop are a single scripted entry
      take('progress', _label)
      return { update: () => undefined, stop: () => undefined }
    },
  }
  return {
    prompter,
    remaining: () => queue.length,
    consumed: () => consumed,
  }
}

const vMock = validateApiKey as unknown as ReturnType<typeof vi.fn>
const rStart = registerAgentStart as unknown as ReturnType<typeof vi.fn>
const rVerify = registerAgentVerify as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  vMock.mockReset()
  rStart.mockReset()
  rVerify.mockReset()
})

const baseRuntime = {} as never
const emptyCfg = {} as never
const liveAgent = {
  handle: 'alice',
  displayName: null,
  email: 'a****@agentchat.local',
  createdAt: '2026-04-20T00:00:00Z',
}

describe('agentchatSetupWizard.prepare', () => {
  it('selects edit flow when an apiKey is already present', async () => {
    const cfg = {
      channels: { agentchat: { apiKey: 'ac_live_'.padEnd(30, 'x') } },
    } as never
    const result = await agentchatSetupWizard.prepare!({
      cfg,
      accountId: 'default',
      credentialValues: {},
      runtime: baseRuntime,
      prompter: scripted([]).prompter,
    })
    expect(result).toEqual({ credentialValues: { _flow: 'edit' } })
  })

  it('selects new flow when no apiKey is set', async () => {
    const result = await agentchatSetupWizard.prepare!({
      cfg: emptyCfg,
      accountId: 'default',
      credentialValues: {},
      runtime: baseRuntime,
      prompter: scripted([]).prompter,
    })
    expect(result).toEqual({ credentialValues: { _flow: 'new' } })
  })
})

describe('agentchatSetupWizard.finalize — have-key path', () => {
  it('validates, writes config, and notes success', async () => {
    vMock.mockResolvedValueOnce({ ok: true, agent: liveAgent })
    const s = scripted([
      { kind: 'select', contains: 'connect this agent', value: 'have-key' },
      {
        kind: 'text',
        contains: 'Paste your AgentChat API key',
        value: 'ac_live_abcdefghij1234567890',
      },
      { kind: 'progress' },
      { kind: 'note', contains: 'Connected to AgentChat' },
    ])

    const result = await agentchatSetupWizard.finalize!({
      cfg: emptyCfg,
      accountId: 'default',
      credentialValues: { _flow: 'new' },
      runtime: baseRuntime,
      prompter: s.prompter,
      forceAllowFrom: false,
    })

    expect(s.remaining()).toBe(0)
    expect(vMock).toHaveBeenCalledOnce()
    const cfg = (result as { cfg: unknown }).cfg
    expect(readAccountApiKey(cfg as never, 'default')).toBe('ac_live_abcdefghij1234567890')
  })

  it('falls back to the new-account flow when the pasted key is rejected', async () => {
    vMock
      .mockResolvedValueOnce({
        ok: false,
        reason: 'unauthorized',
        message: 'API key is invalid',
        status: 401,
      })
      .mockResolvedValueOnce({ ok: true, agent: liveAgent })
    const s = scripted([
      { kind: 'select', contains: 'connect this agent', value: 'have-key' },
      {
        kind: 'text',
        contains: 'Paste your AgentChat API key',
        value: 'ac_live_badkey123456789abcd',
      },
      { kind: 'progress' },
      { kind: 'note', contains: 'AgentChat rejected the key' },
      // bounce: runNewAccountFlow re-asks
      { kind: 'select', contains: 'connect this agent', value: 'have-key' },
      {
        kind: 'text',
        contains: 'Paste your AgentChat API key',
        value: 'ac_live_goodkey1234567890ab',
      },
      { kind: 'progress' },
      { kind: 'note', contains: 'Connected to AgentChat' },
    ])

    const result = await agentchatSetupWizard.finalize!({
      cfg: emptyCfg,
      accountId: 'default',
      credentialValues: { _flow: 'new' },
      runtime: baseRuntime,
      prompter: s.prompter,
      forceAllowFrom: false,
    })

    expect(s.remaining()).toBe(0)
    expect(vMock).toHaveBeenCalledTimes(2)
    expect(readAccountApiKey((result as { cfg: unknown }).cfg as never, 'default')).toBe(
      'ac_live_goodkey1234567890ab',
    )
  })
})

describe('agentchatSetupWizard.finalize — register path', () => {
  it('runs the OTP flow end-to-end', async () => {
    rStart.mockResolvedValueOnce({ ok: true, pendingId: 'pend-123' })
    rVerify.mockResolvedValueOnce({
      ok: true,
      apiKey: 'ac_live_fresh1234567890abcd',
      agent: { ...liveAgent, email: 'alice@example.com' },
    })
    const s = scripted([
      { kind: 'select', contains: 'connect this agent', value: 'register' },
      { kind: 'note', contains: 'email a 6-digit code' },
      { kind: 'text', contains: 'email address', value: 'alice@example.com' },
      { kind: 'text', contains: 'handle', value: 'alice' },
      { kind: 'text', contains: 'Display name', value: 'Alice' },
      { kind: 'text', contains: 'description', value: 'tests' },
      { kind: 'progress' },
      { kind: 'text', contains: '6-digit code', value: '123456' },
      { kind: 'progress' },
      { kind: 'note', contains: 'Registration complete' },
    ])

    const result = await agentchatSetupWizard.finalize!({
      cfg: emptyCfg,
      accountId: 'default',
      credentialValues: { _flow: 'new' },
      runtime: baseRuntime,
      prompter: s.prompter,
      forceAllowFrom: false,
    })

    expect(s.remaining()).toBe(0)
    expect(rStart).toHaveBeenCalledWith(
      {
        email: 'alice@example.com',
        handle: 'alice',
        displayName: 'Alice',
        description: 'tests',
      },
      expect.any(Object),
    )
    expect(rVerify).toHaveBeenCalledWith(
      { pendingId: 'pend-123', code: '123456' },
      expect.any(Object),
    )
    expect(readAccountApiKey((result as { cfg: unknown }).cfg as never, 'default')).toBe(
      'ac_live_fresh1234567890abcd',
    )
  })

  it('re-prompts on invalid-code up to OTP_ATTEMPTS, then aborts', async () => {
    rStart.mockResolvedValueOnce({ ok: true, pendingId: 'pend-777' })
    rVerify
      .mockResolvedValueOnce({ ok: false, reason: 'invalid-code', message: 'wrong', status: 400 })
      .mockResolvedValueOnce({ ok: false, reason: 'invalid-code', message: 'wrong', status: 400 })
      .mockResolvedValueOnce({ ok: false, reason: 'invalid-code', message: 'wrong', status: 400 })
    const s = scripted([
      { kind: 'select', contains: 'connect this agent', value: 'register' },
      { kind: 'note', contains: 'email a 6-digit code' },
      { kind: 'text', contains: 'email address', value: 'bob@example.com' },
      { kind: 'text', contains: 'handle', value: 'bob' },
      { kind: 'text', contains: 'Display name', value: '' },
      { kind: 'text', contains: 'description', value: '' },
      { kind: 'progress' },
      // attempt 1
      { kind: 'text', contains: '6-digit code', value: '111111' },
      { kind: 'progress' },
      { kind: 'note', contains: 'Code rejected' },
      // attempt 2
      { kind: 'text', contains: '6-digit code', value: '222222' },
      { kind: 'progress' },
      { kind: 'note', contains: 'Code rejected' },
      // attempt 3
      { kind: 'text', contains: '6-digit code', value: '333333' },
      { kind: 'progress' },
      { kind: 'note', contains: 'Code rejected' },
      { kind: 'note', contains: 'Too many invalid codes' },
    ])

    const result = await agentchatSetupWizard.finalize!({
      cfg: emptyCfg,
      accountId: 'default',
      credentialValues: { _flow: 'new' },
      runtime: baseRuntime,
      prompter: s.prompter,
      forceAllowFrom: false,
    })

    expect(s.remaining()).toBe(0)
    expect(rVerify).toHaveBeenCalledTimes(3)
    // No config change — cfg returned unchanged
    expect(readAccountApiKey((result as { cfg: unknown }).cfg as never, 'default')).toBeUndefined()
  })

  it('restarts registration on expired code', async () => {
    rStart
      .mockResolvedValueOnce({ ok: true, pendingId: 'pend-a' })
      .mockResolvedValueOnce({ ok: true, pendingId: 'pend-b' })
    rVerify
      .mockResolvedValueOnce({ ok: false, reason: 'expired', message: 'expired', status: 400 })
      .mockResolvedValueOnce({
        ok: true,
        apiKey: 'ac_live_fresh0000000000abcd',
        agent: { ...liveAgent, handle: 'carol', email: 'carol@example.com' },
      })

    const s = scripted([
      { kind: 'select', contains: 'connect this agent', value: 'register' },
      { kind: 'note', contains: 'email a 6-digit code' },
      { kind: 'text', contains: 'email address', value: 'carol@example.com' },
      { kind: 'text', contains: 'handle', value: 'carol' },
      { kind: 'text', contains: 'Display name', value: '' },
      { kind: 'text', contains: 'description', value: '' },
      { kind: 'progress' },
      { kind: 'text', contains: '6-digit code', value: '000000' },
      { kind: 'progress' },
      { kind: 'note', contains: 'Code rejected' },
      // restart
      { kind: 'note', contains: 'email a 6-digit code' },
      { kind: 'text', contains: 'email address', value: 'carol@example.com' },
      { kind: 'text', contains: 'handle', value: 'carol' },
      { kind: 'text', contains: 'Display name', value: '' },
      { kind: 'text', contains: 'description', value: '' },
      { kind: 'progress' },
      { kind: 'text', contains: '6-digit code', value: '999999' },
      { kind: 'progress' },
      { kind: 'note', contains: 'Registration complete' },
    ])

    const result = await agentchatSetupWizard.finalize!({
      cfg: emptyCfg,
      accountId: 'default',
      credentialValues: { _flow: 'new' },
      runtime: baseRuntime,
      prompter: s.prompter,
      forceAllowFrom: false,
    })

    expect(s.remaining()).toBe(0)
    expect(rStart).toHaveBeenCalledTimes(2)
    expect(readAccountApiKey((result as { cfg: unknown }).cfg as never, 'default')).toBe(
      'ac_live_fresh0000000000abcd',
    )
  })

  it('allows the user to bail out after a handle-taken start error', async () => {
    rStart.mockResolvedValueOnce({
      ok: false,
      reason: 'handle-taken',
      message: 'taken',
      status: 409,
    })

    const s = scripted([
      { kind: 'select', contains: 'connect this agent', value: 'register' },
      { kind: 'note', contains: 'email a 6-digit code' },
      { kind: 'text', contains: 'email address', value: 'dave@example.com' },
      { kind: 'text', contains: 'handle', value: 'admin' },
      { kind: 'text', contains: 'Display name', value: '' },
      { kind: 'text', contains: 'description', value: '' },
      { kind: 'progress' },
      { kind: 'note', contains: 'Registration failed' },
      { kind: 'confirm', contains: 'different handle', value: false },
    ])

    const result = await agentchatSetupWizard.finalize!({
      cfg: emptyCfg,
      accountId: 'default',
      credentialValues: { _flow: 'new' },
      runtime: baseRuntime,
      prompter: s.prompter,
      forceAllowFrom: false,
    })

    expect(s.remaining()).toBe(0)
    expect(readAccountApiKey((result as { cfg: unknown }).cfg as never, 'default')).toBeUndefined()
  })
})

describe('agentchatSetupWizard.finalize — edit flow', () => {
  const configuredCfg = {
    channels: { agentchat: { apiKey: 'ac_live_existing12345678abcd' } },
  } as never

  it('validate keeps the current config when the key still works', async () => {
    vMock.mockResolvedValueOnce({ ok: true, agent: liveAgent })
    const s = scripted([
      { kind: 'select', contains: 'already configured', value: 'validate' },
      { kind: 'progress' },
    ])
    const result = await agentchatSetupWizard.finalize!({
      cfg: configuredCfg,
      accountId: 'default',
      credentialValues: { _flow: 'edit' },
      runtime: baseRuntime,
      prompter: s.prompter,
      forceAllowFrom: false,
    })
    expect(s.remaining()).toBe(0)
    expect(readAccountApiKey((result as { cfg: unknown }).cfg as never, 'default')).toBe(
      'ac_live_existing12345678abcd',
    )
  })

  it('validate offers rotate when the key broke', async () => {
    vMock
      .mockResolvedValueOnce({ ok: false, reason: 'unauthorized', message: 'revoked', status: 401 })
      .mockResolvedValueOnce({ ok: true, agent: { ...liveAgent, handle: 'dave' } })
    const s = scripted([
      { kind: 'select', contains: 'already configured', value: 'validate' },
      { kind: 'progress' },
      { kind: 'note', contains: 'Re-validation failed' },
      { kind: 'confirm', contains: 'Rotate to a new key', value: true },
      // runNewAccountFlow
      { kind: 'select', contains: 'connect this agent', value: 'have-key' },
      {
        kind: 'text',
        contains: 'Paste your AgentChat API key',
        value: 'ac_live_rotated12345678xyz',
      },
      { kind: 'progress' },
      { kind: 'note', contains: 'Connected to AgentChat' },
    ])
    const result = await agentchatSetupWizard.finalize!({
      cfg: configuredCfg,
      accountId: 'default',
      credentialValues: { _flow: 'edit' },
      runtime: baseRuntime,
      prompter: s.prompter,
      forceAllowFrom: false,
    })
    expect(s.remaining()).toBe(0)
    expect(readAccountApiKey((result as { cfg: unknown }).cfg as never, 'default')).toBe(
      'ac_live_rotated12345678xyz',
    )
  })

  it('change-base writes the new URL', async () => {
    const s = scripted([
      { kind: 'select', contains: 'already configured', value: 'change-base' },
      { kind: 'text', contains: 'API base URL', value: 'https://staging.agentchat.me' },
      { kind: 'note', contains: 'API base set to' },
    ])
    const result = await agentchatSetupWizard.finalize!({
      cfg: configuredCfg,
      accountId: 'default',
      credentialValues: { _flow: 'edit' },
      runtime: baseRuntime,
      prompter: s.prompter,
      forceAllowFrom: false,
    })
    expect(s.remaining()).toBe(0)
    const cfg = (result as { cfg: { channels: { agentchat: { apiBase: string } } } }).cfg
    expect(cfg.channels.agentchat.apiBase).toBe('https://staging.agentchat.me')
  })

  it('skip leaves cfg untouched', async () => {
    const s = scripted([{ kind: 'select', contains: 'already configured', value: 'skip' }])
    const result = await agentchatSetupWizard.finalize!({
      cfg: configuredCfg,
      accountId: 'default',
      credentialValues: { _flow: 'edit' },
      runtime: baseRuntime,
      prompter: s.prompter,
      forceAllowFrom: false,
    })
    expect(s.remaining()).toBe(0)
    expect((result as { cfg: unknown }).cfg).toBe(configuredCfg)
  })
})

describe('agentchatSetupWizard.status', () => {
  it('marks unconfigured cfg as unconfigured', async () => {
    const status = agentchatSetupWizard.status
    expect(await status.resolveConfigured({ cfg: {} as never })).toBe(false)
    const lines = await status.resolveStatusLines!({
      cfg: {} as never,
      configured: false,
    })
    expect(lines[0]).toMatch(/needs API key/)
  })

  it('reports connected identity when probe succeeds', async () => {
    vMock.mockResolvedValueOnce({ ok: true, agent: liveAgent })
    const cfg = {
      channels: { agentchat: { apiKey: 'ac_live_existing12345678abcd' } },
    } as never
    const lines = await agentchatSetupWizard.status.resolveStatusLines!({
      cfg,
      configured: true,
    })
    expect(lines[0]).toMatch(/connected as @alice/)
  })

  it('reports degraded state when probe fails', async () => {
    vMock.mockResolvedValueOnce({
      ok: false,
      reason: 'unreachable',
      message: 'ECONNREFUSED',
    })
    const cfg = {
      channels: { agentchat: { apiKey: 'ac_live_existing12345678abcd' } },
    } as never
    const lines = await agentchatSetupWizard.status.resolveStatusLines!({
      cfg,
      configured: true,
    })
    expect(lines[0]).toMatch(/live probe failed: unreachable/)
  })
})

describe('writeAccountPatch', () => {
  it('writes flat form for default account on an empty cfg', () => {
    const next = writeAccountPatch({} as never, 'default', {
      apiKey: 'ac_live_abcdefghij1234567890',
    })
    expect((next as { channels: { agentchat: { apiKey: string } } }).channels.agentchat.apiKey).toBe(
      'ac_live_abcdefghij1234567890',
    )
  })

  it('writes into accounts map for a non-default account id', () => {
    const next = writeAccountPatch({} as never, 'staging', {
      apiKey: 'ac_live_abcdefghij1234567890',
      apiBase: 'https://staging.agentchat.me',
    })
    const section = (
      next as {
        channels: {
          agentchat: {
            accounts?: Record<string, { apiKey?: string; apiBase?: string }>
          }
        }
      }
    ).channels.agentchat
    expect(section.accounts?.staging?.apiKey).toBe('ac_live_abcdefghij1234567890')
    expect(section.accounts?.staging?.apiBase).toBe('https://staging.agentchat.me')
  })

  it('preserves existing accounts map when writing default', () => {
    const cfg = {
      channels: {
        agentchat: {
          accounts: {
            primary: { apiKey: 'ac_live_primary123456789abcd' },
          },
        },
      },
    } as never
    const next = writeAccountPatch(cfg, 'default', {
      apiKey: 'ac_live_default123456789abcd',
    })
    const section = (
      next as {
        channels: {
          agentchat: {
            accounts?: Record<string, { apiKey?: string }>
          }
        }
      }
    ).channels.agentchat
    expect(section.accounts?.primary?.apiKey).toBe('ac_live_primary123456789abcd')
    expect(section.accounts?.default?.apiKey).toBe('ac_live_default123456789abcd')
  })
})
