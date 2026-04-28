/**
 * Tests for the interactive channel setup wizard (`channel.wizard.ts`).
 *
 * The WizardPrompter interface is replaced by a `scriptedPrompter` that
 * consumes an ordered list of expected prompts (`note`, `select`, `text`,
 * `confirm`, `progress`). Any deviation — wrong prompt kind, scripted value
 * rejected by the prompt's `validate`, surplus or missing steps — fails
 * the test. This pins the wizard's control flow end-to-end without needing
 * a real TTY.
 *
 * Coverage:
 *   - `prepare` dispatch: register-or-paste menu when unconfigured,
 *     edit menu (keep / change-base / replace-key) when re-run against
 *     an already-configured account.
 *   - The change-base flow: accepts a valid URL, rejects invalid input
 *     at the validate step, resets to default when blank.
 *   - `runRegisterFlow` happy path (email → handle → OTP → minted key)
 *     and the key retryable start-errors (handle-taken, email-taken).
 *   - `finalize` validation against the live `/v1/agents/me` probe —
 *     success path captures the handle; failure path notes the warning
 *     without throwing so the config still persists.
 *   - `status.resolveStatusLines` for both configured and unconfigured.
 *
 * setup-client is stubbed via `vi.mock` so the server responses are under
 * test control.
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
import { agentchatSetupWizard } from '../src/channel.wizard.js'
import {
  applyAgentchatAccountPatch,
  readAgentchatConfigField,
} from '../src/channel-account.js'

type Scripted =
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
      /* no-op — OpenClaw's setup driver handles intro/outro at a higher level */
    },
    outro: async () => {
      /* no-op */
    },
    note: async (message: string, title?: string) => {
      take('note', `${title ?? ''}\n${message}`)
    },
    text: async (params: {
      message: string
      validate?: (v: string) => string | undefined
    }) => {
      const entry = take('text', params.message)
      if (params.validate) {
        const err = params.validate(entry.value)
        if (err) {
          throw new Error(
            `scripted value "${entry.value}" rejected by validate for "${params.message}": ${err}`,
          )
        }
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

const emptyCfg = {} as never
const configuredCfg = applyAgentchatAccountPatch(emptyCfg, 'default', {
  apiKey: 'ac_live_abcdef0123456789abcd',
  agentHandle: 'alice',
}) as never

const liveAgent = {
  handle: 'alice',
  displayName: null,
  email: 'a****@agentchat.local',
  createdAt: '2026-04-20T00:00:00Z',
}

describe('agentchatSetupWizard.prepare — dispatch', () => {
  it('shows the register-or-paste menu when no key is configured', async () => {
    const s = scripted([
      { kind: 'select', contains: 'How would you like to configure', value: 'paste' },
    ])
    const result = await agentchatSetupWizard.prepare!({
      cfg: emptyCfg,
      accountId: 'default',
      credentialValues: {},
      prompter: s.prompter as never,
    } as never)

    expect(result).toBeUndefined()
    expect(s.remaining()).toBe(0)
  })

  it('shows the edit menu when already configured and the user keeps it', async () => {
    const s = scripted([
      { kind: 'select', contains: 'already configured', value: 'keep' },
    ])
    const result = await agentchatSetupWizard.prepare!({
      cfg: configuredCfg,
      accountId: 'default',
      credentialValues: { token: 'ac_live_abcdef0123456789abcd' },
      prompter: s.prompter as never,
    } as never)

    expect(result).toBeUndefined()
    expect(s.remaining()).toBe(0)
  })

  it('falls through to the register-or-paste menu when the user picks replace-key', async () => {
    const s = scripted([
      { kind: 'select', contains: 'already configured', value: 'replace-key' },
      { kind: 'select', contains: 'How would you like to configure', value: 'paste' },
    ])
    const result = await agentchatSetupWizard.prepare!({
      cfg: configuredCfg,
      accountId: 'default',
      credentialValues: { token: 'ac_live_abcdef0123456789abcd' },
      prompter: s.prompter as never,
    } as never)

    expect(result).toBeUndefined()
    expect(s.remaining()).toBe(0)
  })
})

describe('agentchatSetupWizard.prepare — change-base flow', () => {
  it('writes the new apiBase to cfg', async () => {
    const s = scripted([
      { kind: 'select', contains: 'already configured', value: 'change-base' },
      { kind: 'text', contains: 'New API base URL', value: 'https://staging.agentchat.me' },
      { kind: 'note', contains: 'API base set to https://staging.agentchat.me' },
    ])
    const result = await agentchatSetupWizard.prepare!({
      cfg: configuredCfg,
      accountId: 'default',
      credentialValues: { token: 'ac_live_abcdef0123456789abcd' },
      prompter: s.prompter as never,
    } as never)

    expect(result).toBeDefined()
    const patched = (result as { cfg: unknown }).cfg
    expect(readAgentchatConfigField(patched as never, 'default', 'apiBase')).toBe(
      'https://staging.agentchat.me',
    )
    expect(s.remaining()).toBe(0)
  })

  it('resets the apiBase to the schema default when the input is blank', async () => {
    // Seed a custom apiBase first so we can observe the reset.
    const withCustomBase = applyAgentchatAccountPatch(configuredCfg, 'default', {
      apiBase: 'https://staging.agentchat.me',
    })

    const s = scripted([
      { kind: 'select', contains: 'already configured', value: 'change-base' },
      { kind: 'text', contains: 'New API base URL', value: '' },
      { kind: 'note', contains: 'reset to default' },
    ])
    const result = await agentchatSetupWizard.prepare!({
      cfg: withCustomBase as never,
      accountId: 'default',
      credentialValues: { token: 'ac_live_abcdef0123456789abcd' },
      prompter: s.prompter as never,
    } as never)

    expect(result).toBeDefined()
    const patched = (result as { cfg: unknown }).cfg
    expect(readAgentchatConfigField(patched as never, 'default', 'apiBase')).toBeUndefined()
    expect(s.remaining()).toBe(0)
  })

  it('rejects an obviously malformed URL at the validate step', async () => {
    const s = scripted([
      { kind: 'select', contains: 'already configured', value: 'change-base' },
      { kind: 'text', contains: 'New API base URL', value: 'not-a-url' },
    ])
    await expect(
      agentchatSetupWizard.prepare!({
        cfg: configuredCfg,
        accountId: 'default',
        credentialValues: { token: 'ac_live_abcdef0123456789abcd' },
        prompter: s.prompter as never,
      } as never),
    ).rejects.toThrow(/Not a valid URL/)
  })

  it('rejects non-http(s) protocols at the validate step', async () => {
    const s = scripted([
      { kind: 'select', contains: 'already configured', value: 'change-base' },
      { kind: 'text', contains: 'New API base URL', value: 'ftp://example.com' },
    ])
    await expect(
      agentchatSetupWizard.prepare!({
        cfg: configuredCfg,
        accountId: 'default',
        credentialValues: { token: 'ac_live_abcdef0123456789abcd' },
        prompter: s.prompter as never,
      } as never),
    ).rejects.toThrow(/http:\/\/ or https:\/\//)
  })
})

describe('agentchatSetupWizard.prepare — register flow happy path', () => {
  it('registers via OTP and writes the minted key into cfg', async () => {
    rStart.mockResolvedValueOnce({ ok: true, pendingId: 'pnd_1' })
    rVerify.mockResolvedValueOnce({
      ok: true,
      agent: {
        id: 'agt_1',
        handle: 'alice',
        email: 'alice@example.com',
        createdAt: '2026-04-21T00:00:00Z',
      },
      apiKey: 'ac_live_0123456789abcdef0123',
    })

    const s = scripted([
      { kind: 'select', contains: 'How would you like to configure', value: 'register' },
      { kind: 'note', contains: 'register a new agent' },
      { kind: 'text', contains: 'Email', value: 'alice@example.com' },
      { kind: 'text', contains: 'lowercase a-z', value: 'alice' },
      { kind: 'text', contains: 'Display name', value: '' },
      { kind: 'progress' },
      { kind: 'text', contains: 'verification code', value: '123456' },
      { kind: 'progress' },
      { kind: 'note', contains: 'AgentChat account created' },
    ])

    const result = await agentchatSetupWizard.prepare!({
      cfg: emptyCfg,
      accountId: 'default',
      credentialValues: {},
      prompter: s.prompter as never,
    } as never)

    expect(result).toBeDefined()
    const { cfg, credentialValues } = result as {
      cfg: unknown
      credentialValues: Record<string, string>
    }
    expect(readAgentchatConfigField(cfg as never, 'default', 'apiKey')).toBe(
      'ac_live_0123456789abcdef0123',
    )
    expect(readAgentchatConfigField(cfg as never, 'default', 'agentHandle')).toBe('alice')
    expect(credentialValues.token).toBe('ac_live_0123456789abcdef0123')
    expect(s.remaining()).toBe(0)
  })
})

describe('agentchatSetupWizard.prepare — register flow retryable errors', () => {
  it('re-prompts for handle after a handle-taken start error', async () => {
    rStart
      .mockResolvedValueOnce({ ok: false, reason: 'handle-taken' })
      .mockResolvedValueOnce({ ok: true, pendingId: 'pnd_2' })
    rVerify.mockResolvedValueOnce({
      ok: true,
      agent: {
        id: 'agt_2',
        handle: 'alice2',
        email: 'alice@example.com',
        createdAt: '2026-04-21T00:00:00Z',
      },
      apiKey: 'ac_live_fedcba9876543210fedc',
    })

    const s = scripted([
      { kind: 'select', contains: 'How would you like to configure', value: 'register' },
      { kind: 'note', contains: 'register a new agent' },
      { kind: 'text', contains: 'Email', value: 'alice@example.com' },
      { kind: 'text', contains: 'lowercase a-z', value: 'alice' },
      { kind: 'text', contains: 'Display name', value: '' },
      { kind: 'progress' },
      { kind: 'note', contains: 'already taken' },
      { kind: 'text', contains: 'lowercase a-z', value: 'alice2' },
      { kind: 'progress' },
      { kind: 'text', contains: 'verification code', value: '123456' },
      { kind: 'progress' },
      { kind: 'note', contains: 'AgentChat account created' },
    ])

    const result = await agentchatSetupWizard.prepare!({
      cfg: emptyCfg,
      accountId: 'default',
      credentialValues: {},
      prompter: s.prompter as never,
    } as never)

    expect(result).toBeDefined()
    expect(rStart).toHaveBeenCalledTimes(2)
    expect(s.remaining()).toBe(0)
  })

  it('returns user-chose-paste when the user picks "paste existing key" after email-taken', async () => {
    rStart.mockResolvedValueOnce({ ok: false, reason: 'email-taken' })

    const s = scripted([
      { kind: 'select', contains: 'How would you like to configure', value: 'register' },
      { kind: 'note', contains: 'register a new agent' },
      { kind: 'text', contains: 'Email', value: 'alice@example.com' },
      { kind: 'text', contains: 'lowercase a-z', value: 'alice' },
      { kind: 'text', contains: 'Display name', value: '' },
      { kind: 'progress' },
      { kind: 'select', contains: 'already registered', value: 'paste' },
    ])

    const result = await agentchatSetupWizard.prepare!({
      cfg: emptyCfg,
      accountId: 'default',
      credentialValues: {},
      prompter: s.prompter as never,
    } as never)

    // When the user chose paste, prepare returns undefined (no cfg change)
    // and the framework's credential prompt fires on the next step.
    expect(result).toBeUndefined()
    expect(s.remaining()).toBe(0)
  })
})

describe('agentchatSetupWizard.finalize', () => {
  it('succeeds when the probe authenticates and captures the server handle', async () => {
    vMock.mockResolvedValueOnce({ ok: true, agent: liveAgent })

    const s = scripted([
      { kind: 'progress' },
    ])

    const result = await agentchatSetupWizard.finalize!({
      cfg: applyAgentchatAccountPatch(emptyCfg, 'default', {
        apiKey: 'ac_live_abcdef0123456789abcd',
      }) as never,
      accountId: 'default',
      credentialValues: { token: 'ac_live_abcdef0123456789abcd' },
      prompter: s.prompter as never,
    } as never)

    expect(result).toBeDefined()
    const patched = (result as { cfg: unknown }).cfg
    expect(readAgentchatConfigField(patched as never, 'default', 'agentHandle')).toBe('alice')
    expect(s.remaining()).toBe(0)
  })

  it('surfaces a warning but keeps the config when the key fails live probe', async () => {
    vMock.mockResolvedValueOnce({
      ok: false,
      reason: 'unauthorized',
      message: 'API key is invalid',
    })

    const s = scripted([
      { kind: 'progress' },
      { kind: 'note', contains: 'AgentChat validation warning' },
    ])

    const result = await agentchatSetupWizard.finalize!({
      cfg: applyAgentchatAccountPatch(emptyCfg, 'default', {
        apiKey: 'ac_live_bad00000000000000000',
      }) as never,
      accountId: 'default',
      credentialValues: { token: 'ac_live_bad00000000000000000' },
      prompter: s.prompter as never,
    } as never)

    // finalize returns undefined on a probe failure — the cfg the framework
    // already persisted stays. Runtime will retry on startup.
    expect(result).toBeUndefined()
    expect(s.remaining()).toBe(0)
  })

  it('is a no-op when no API key is present in cfg or credentialValues', async () => {
    const s = scripted([])
    const result = await agentchatSetupWizard.finalize!({
      cfg: emptyCfg,
      accountId: 'default',
      credentialValues: {},
      prompter: s.prompter as never,
    } as never)

    expect(result).toBeUndefined()
    expect(vMock).not.toHaveBeenCalled()
  })
})

describe('agentchatSetupWizard.status', () => {
  it('reports "not configured" with a hint when no key is present', async () => {
    const status = agentchatSetupWizard.status!
    const configured = status.resolveConfigured({ cfg: emptyCfg, accountId: 'default' } as never)
    expect(configured).toBe(false)

    // `resolveStatusLines` is typed `string[] | Promise<string[]>` at the
    // plugin-sdk level to allow async implementations; `await` works for
    // both shapes. Non-null assert because the field is optional in the
    // interface (our implementation always provides it).
    const lines = await status.resolveStatusLines!({
      cfg: emptyCfg,
      accountId: 'default',
      configured: false,
    } as never)
    expect(lines.join(' ')).toMatch(/not configured/)
  })

  it('reports "configured (@handle)" when both key and handle are present', async () => {
    const status = agentchatSetupWizard.status!
    const configured = status.resolveConfigured({
      cfg: configuredCfg,
      accountId: 'default',
    } as never)
    expect(configured).toBe(true)

    const lines = await status.resolveStatusLines!({
      cfg: configuredCfg,
      accountId: 'default',
      configured: true,
    } as never)
    expect(lines.join(' ')).toMatch(/configured \(@alice\)/)
  })
})

describe('applyAgentchatAccountPatch', () => {
  it('writes to the flat channels.agentchat.* shape for the default account', () => {
    const patched = applyAgentchatAccountPatch(emptyCfg, 'default', {
      apiKey: 'ac_live_abcdef0123456789abcd',
      agentHandle: 'alice',
    })
    expect(readAgentchatConfigField(patched, 'default', 'apiKey')).toBe(
      'ac_live_abcdef0123456789abcd',
    )
    expect(readAgentchatConfigField(patched, 'default', 'agentHandle')).toBe('alice')
  })

  it('writes to the accounts-map shape for a non-default account id', () => {
    const patched = applyAgentchatAccountPatch(emptyCfg, 'staging', {
      apiKey: 'ac_live_stagingkey0000000000',
      apiBase: 'https://staging.agentchat.me',
    })
    expect(readAgentchatConfigField(patched, 'staging', 'apiKey')).toBe(
      'ac_live_stagingkey0000000000',
    )
    expect(readAgentchatConfigField(patched, 'staging', 'apiBase')).toBe(
      'https://staging.agentchat.me',
    )
    // Does not leak into the default account.
    expect(readAgentchatConfigField(patched, 'default', 'apiKey')).toBeUndefined()
  })

  it('treats an undefined field value as a removal', () => {
    const seeded = applyAgentchatAccountPatch(emptyCfg, 'default', {
      apiKey: 'ac_live_abcdef0123456789abcd',
      apiBase: 'https://staging.agentchat.me',
    })
    const patched = applyAgentchatAccountPatch(seeded, 'default', {
      apiBase: undefined,
    })
    expect(readAgentchatConfigField(patched, 'default', 'apiBase')).toBeUndefined()
    // apiKey untouched.
    expect(readAgentchatConfigField(patched, 'default', 'apiKey')).toBe(
      'ac_live_abcdef0123456789abcd',
    )
  })
})
