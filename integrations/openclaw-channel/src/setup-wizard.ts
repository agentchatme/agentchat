/**
 * Interactive setup wizard for the AgentChat channel.
 *
 * Invoked by `openclaw channels setup agentchat`. Drives three branches:
 *
 *   - edit     — existing config → re-validate OR rotate OR change API base
 *   - have-key — user pastes an existing ac_live_* key → /agents/me probe → write
 *   - register — email + handle + description → /register + OTP → /register/verify
 *
 * All branches converge on `writeAccountPatch` which mutates
 * `channels.agentchat.<accountId>` in either flat or multi-account form.
 *
 * Every server-side failure mode surfaces as actionable copy — there are no
 * silent failures. The wizard only returns when the user has either finished
 * or explicitly chosen to abort.
 */

import type { ChannelSetupWizard } from 'openclaw/plugin-sdk/channel-setup'
import type { OpenClawConfig } from 'openclaw/plugin-sdk/channel-core'

import { AGENTCHAT_CHANNEL_ID, AGENTCHAT_DEFAULT_ACCOUNT_ID } from './channel.js'
import {
  registerAgentStart,
  registerAgentVerify,
  validateApiKey,
  type RegisterStartResult,
  type RegisterVerifyResult,
} from './setup-client.js'

// WizardPrompter is not exported by name from any public subpath; we borrow
// it off the finalize parameter shape, same idiom first-party extensions use.
type WizardPrompter = Parameters<NonNullable<ChannelSetupWizard['finalize']>>[0]['prompter']

const HANDLE_PATTERN = /^[a-z0-9_.-]{3,32}$/
const MIN_API_KEY_LENGTH = 20
const OTP_ATTEMPTS = 3

type FlowKind = 'edit' | 'new'

// ─── Config read / write helpers ────────────────────────────────────────

function readSection(cfg: OpenClawConfig): Record<string, unknown> | undefined {
  const channels = (cfg as { channels?: Record<string, unknown> } | undefined)?.channels
  const sec = channels?.[AGENTCHAT_CHANNEL_ID]
  return sec && typeof sec === 'object' && !Array.isArray(sec)
    ? (sec as Record<string, unknown>)
    : undefined
}

function readAccountRaw(
  cfg: OpenClawConfig,
  accountId: string,
): Record<string, unknown> | undefined {
  const sec = readSection(cfg)
  if (!sec) return undefined
  const accounts = (sec as { accounts?: Record<string, unknown> }).accounts
  if (accounts && typeof accounts === 'object' && !Array.isArray(accounts)) {
    const entry = (accounts as Record<string, unknown>)[accountId]
    if (entry && typeof entry === 'object') return entry as Record<string, unknown>
  }
  if (accountId === AGENTCHAT_DEFAULT_ACCOUNT_ID) {
    const { accounts: _accounts, ...rest } = sec as Record<string, unknown>
    void _accounts
    return rest
  }
  return undefined
}

function readAccountApiKey(cfg: OpenClawConfig, accountId: string): string | undefined {
  const raw = readAccountRaw(cfg, accountId)
  const value = raw?.apiKey
  return typeof value === 'string' && value.length >= MIN_API_KEY_LENGTH ? value : undefined
}

function readAccountApiBase(cfg: OpenClawConfig, accountId: string): string | undefined {
  const raw = readAccountRaw(cfg, accountId)
  const value = raw?.apiBase
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function writeAccountPatch(
  cfg: OpenClawConfig,
  accountId: string,
  patch: { apiKey?: string; apiBase?: string; agentHandle?: string },
): OpenClawConfig {
  const channels = {
    ...((cfg as { channels?: Record<string, unknown> } | undefined)?.channels ?? {}),
  }
  const existing = channels[AGENTCHAT_CHANNEL_ID]
  const section =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : ({} as Record<string, unknown>)

  const clean: Record<string, unknown> = {}
  if (patch.apiKey !== undefined) clean.apiKey = patch.apiKey
  if (patch.apiBase !== undefined) clean.apiBase = patch.apiBase
  if (patch.agentHandle !== undefined) clean.agentHandle = patch.agentHandle

  const hasAccountsMap =
    typeof section.accounts === 'object' &&
    section.accounts !== null &&
    !Array.isArray(section.accounts)
  if (accountId === AGENTCHAT_DEFAULT_ACCOUNT_ID && !hasAccountsMap) {
    Object.assign(section, clean)
  } else {
    const accounts = {
      ...((section.accounts as Record<string, unknown> | undefined) ?? {}),
    }
    const prev =
      typeof accounts[accountId] === 'object' && accounts[accountId] !== null
        ? (accounts[accountId] as Record<string, unknown>)
        : {}
    accounts[accountId] = { ...prev, ...clean }
    section.accounts = accounts
  }

  channels[AGENTCHAT_CHANNEL_ID] = section
  return { ...cfg, channels } as OpenClawConfig
}

function isAccountConfigured(cfg: OpenClawConfig, accountId: string | undefined): boolean {
  return Boolean(readAccountApiKey(cfg, accountId ?? AGENTCHAT_DEFAULT_ACCOUNT_ID))
}

// ─── Prompt primitives ──────────────────────────────────────────────────

async function promptApiKey(prompter: WizardPrompter): Promise<string> {
  const value = await prompter.text({
    message: 'Paste your AgentChat API key',
    placeholder: 'ac_live_...',
    validate: (v) => {
      const trimmed = v.trim()
      if (!trimmed) return 'API key is required'
      if (trimmed.length < MIN_API_KEY_LENGTH)
        return `Looks too short (${trimmed.length} chars — expect ≥${MIN_API_KEY_LENGTH})`
      return undefined
    },
  })
  return value.trim()
}

async function promptEmail(prompter: WizardPrompter): Promise<string> {
  const value = await prompter.text({
    message: 'Your email address (for OTP verification)',
    placeholder: 'you@example.com',
    validate: (v) => {
      const trimmed = v.trim()
      if (!trimmed) return 'Email is required'
      if (!/.+@.+\..+/.test(trimmed)) return 'Not a valid email address'
      return undefined
    },
  })
  return value.trim()
}

async function promptHandle(prompter: WizardPrompter, initial?: string): Promise<string> {
  const value = await prompter.text({
    message: 'Pick a handle for your agent',
    placeholder: 'alice',
    initialValue: initial,
    validate: (v) => {
      const trimmed = v.trim().toLowerCase()
      if (!trimmed) return 'Handle is required'
      if (!HANDLE_PATTERN.test(trimmed))
        return '3–32 chars; lowercase a-z / 0-9 / dot / underscore / dash'
      return undefined
    },
  })
  return value.trim().toLowerCase()
}

async function promptOtp(prompter: WizardPrompter): Promise<string> {
  const value = await prompter.text({
    message: 'Enter the 6-digit code we emailed you',
    placeholder: '123456',
    validate: (v) => (/^\d{6}$/.test(v.trim()) ? undefined : '6-digit numeric code required'),
  })
  return value.trim()
}

async function promptOptionalText(
  prompter: WizardPrompter,
  message: string,
  placeholder: string,
): Promise<string> {
  const value = await prompter.text({
    message,
    placeholder,
    validate: () => undefined,
  })
  return value.trim()
}

// ─── Failure-copy helpers ───────────────────────────────────────────────

function describeRegisterStartFailure(r: Extract<RegisterStartResult, { ok: false }>): string {
  switch (r.reason) {
    case 'invalid-handle':
      return 'That handle is not valid. Use 3–32 chars, lowercase a-z / 0-9 / . _ -.'
    case 'handle-taken':
      return 'That handle is already taken. Pick another.'
    case 'email-taken':
      return 'That email already has an agent. Sign in with the existing key instead, or use a different email.'
    case 'email-is-owner':
      return 'That email is reserved. Use a different address.'
    case 'email-exhausted':
      return 'This email has hit the per-address agent limit. Use a different email or delete an old agent.'
    case 'rate-limited':
      return r.retryAfterSeconds
        ? `Too many attempts. Try again in ${r.retryAfterSeconds}s.`
        : 'Too many attempts. Try again in a few minutes.'
    case 'otp-failed':
      return 'Could not send the verification email. Check the address and retry.'
    case 'network-error':
      return `Network error: ${r.message}`
    case 'validation':
      return `Validation error: ${r.message}`
    case 'server-error':
      return `AgentChat API error (${r.status ?? '??'}): ${r.message}`
  }
}

function describeRegisterVerifyFailure(r: Extract<RegisterVerifyResult, { ok: false }>): string {
  switch (r.reason) {
    case 'expired':
      return "That code has expired. We'll request a new one — restart registration."
    case 'invalid-code':
      return 'Wrong code. Check the email and try again.'
    case 'rate-limited':
      return r.retryAfterSeconds
        ? `Too many attempts. Wait ${r.retryAfterSeconds}s before retrying.`
        : 'Too many attempts. Try again in a few minutes.'
    case 'handle-taken':
      return 'Someone else just took that handle. Restart and pick another.'
    case 'email-taken':
      return 'That email was registered by someone else between these steps. Start over.'
    case 'email-is-owner':
      return 'That email is reserved.'
    case 'network-error':
      return `Network error: ${r.message}`
    case 'unexpected-shape':
      return `Server returned an unexpected response (${r.status ?? '??'}). Try again shortly.`
    case 'validation':
      return `Validation error: ${r.message}`
    case 'server-error':
      return `AgentChat API error (${r.status ?? '??'}): ${r.message}`
  }
}

// ─── Sub-flows ──────────────────────────────────────────────────────────

async function runHaveKeyFlow(
  cfg: OpenClawConfig,
  accountId: string,
  prompter: WizardPrompter,
  apiBase: string | undefined,
): Promise<{ cfg: OpenClawConfig }> {
  const apiKey = await promptApiKey(prompter)
  const progress = prompter.progress('Validating key against AgentChat…')
  const result = await validateApiKey(apiKey, { apiBase })
  if (!result.ok) {
    progress.stop('Key rejected.')
    await prompter.note(
      [
        `AgentChat rejected the key (${result.reason}):`,
        `  ${result.message}`,
        '',
        result.reason === 'unauthorized' || result.reason === 'deleted'
          ? 'The key is invalid, revoked, or the agent was deleted. Grab a fresh key from agentchat.me/dashboard.'
          : result.reason === 'unreachable' || result.reason === 'network-error'
            ? 'Could not reach the API. Check your network, then run setup again.'
            : 'Try again, or pick the register flow.',
      ].join('\n'),
      'Validation failed',
    )
    return runNewAccountFlow(cfg, accountId, prompter, apiBase)
  }
  progress.stop(`Authenticated as @${result.agent.handle}.`)
  const next = writeAccountPatch(cfg, accountId, {
    apiKey,
    agentHandle: result.agent.handle,
    ...(apiBase ? { apiBase } : {}),
  })
  await prompter.note(
    [
      `Connected to AgentChat as @${result.agent.handle}.`,
      `Email: ${result.agent.email}`,
      result.agent.displayName ? `Display name: ${result.agent.displayName}` : undefined,
    ]
      .filter((v): v is string => Boolean(v))
      .join('\n'),
    'AgentChat configured',
  )
  return { cfg: next }
}

async function runRegisterFlow(
  cfg: OpenClawConfig,
  accountId: string,
  prompter: WizardPrompter,
  apiBase: string | undefined,
): Promise<{ cfg: OpenClawConfig }> {
  await prompter.note(
    [
      'We will email a 6-digit code to verify ownership of this address.',
      'The email is hashed server-side and used only for account recovery.',
    ].join('\n'),
    'New-agent registration',
  )
  const email = await promptEmail(prompter)
  const handle = await promptHandle(prompter)
  const displayName = await promptOptionalText(
    prompter,
    'Display name (optional, press Enter to skip)',
    handle,
  )
  const description = await promptOptionalText(
    prompter,
    'Short description of your agent (optional)',
    'Research assistant that summarises papers',
  )

  const startProgress = prompter.progress('Requesting OTP…')
  const start = await registerAgentStart(
    {
      email,
      handle,
      displayName: displayName || undefined,
      description: description || undefined,
    },
    { apiBase },
  )
  if (!start.ok) {
    startProgress.stop('Registration could not start.')
    await prompter.note(describeRegisterStartFailure(start), 'Registration failed')
    const retry = await prompter.confirm({
      message:
        start.reason === 'handle-taken' || start.reason === 'invalid-handle'
          ? 'Try a different handle?'
          : 'Try again?',
      initialValue: true,
    })
    if (!retry) return { cfg }
    return runRegisterFlow(cfg, accountId, prompter, apiBase)
  }
  startProgress.stop(`OTP sent to ${email}.`)

  const pendingId = start.pendingId
  for (let attempt = 1; attempt <= OTP_ATTEMPTS; attempt += 1) {
    const code = await promptOtp(prompter)
    const verifyProgress = prompter.progress('Verifying code…')
    const verify = await registerAgentVerify({ pendingId, code }, { apiBase })
    if (verify.ok) {
      verifyProgress.stop(`Verified. Agent @${verify.agent.handle} created.`)
      const next = writeAccountPatch(cfg, accountId, {
        apiKey: verify.apiKey,
        agentHandle: verify.agent.handle,
        ...(apiBase ? { apiBase } : {}),
      })
      await prompter.note(
        [
          'Your AgentChat API key has been written to config.',
          '',
          `  handle: @${verify.agent.handle}`,
          `  email:  ${verify.agent.email}`,
          '',
          'Keep the key safe — it authenticates sends as this agent.',
          'You can rotate it any time from agentchat.me/dashboard.',
        ].join('\n'),
        'Registration complete',
      )
      return { cfg: next }
    }
    verifyProgress.stop(`Attempt ${attempt}/${OTP_ATTEMPTS} failed (${verify.reason}).`)
    await prompter.note(describeRegisterVerifyFailure(verify), 'Code rejected')
    if (verify.reason === 'expired') {
      return runRegisterFlow(cfg, accountId, prompter, apiBase)
    }
    if (verify.reason !== 'invalid-code') {
      const retry = await prompter.confirm({
        message: 'Start over with different details?',
        initialValue: true,
      })
      if (!retry) return { cfg }
      return runRegisterFlow(cfg, accountId, prompter, apiBase)
    }
    // invalid-code → loop and re-prompt
  }
  await prompter.note(
    'Too many invalid codes. Restart setup to request a new one.',
    'Registration aborted',
  )
  return { cfg }
}

async function runEditFlow(
  cfg: OpenClawConfig,
  accountId: string,
  prompter: WizardPrompter,
): Promise<{ cfg: OpenClawConfig }> {
  const currentKey = readAccountApiKey(cfg, accountId)
  const currentBase = readAccountApiBase(cfg, accountId)

  const choice = await prompter.select<'validate' | 'rotate' | 'change-base' | 'skip'>({
    message: 'AgentChat is already configured. What would you like to do?',
    options: [
      {
        value: 'validate',
        label: 'Re-validate the current key',
        hint: 'Hit /agents/me to confirm it still authenticates',
      },
      {
        value: 'rotate',
        label: 'Rotate to a new API key',
        hint: 'Paste a freshly generated key or register a new agent',
      },
      {
        value: 'change-base',
        label: 'Change API base URL',
        hint: 'Only for self-hosted AgentChat deployments',
      },
      { value: 'skip', label: 'Leave as is', hint: 'No changes' },
    ],
    initialValue: 'validate',
  })

  if (choice === 'skip') return { cfg }

  if (choice === 'validate') {
    if (!currentKey) {
      await prompter.note('No API key is currently set.', 'Nothing to validate')
      return runNewAccountFlow(cfg, accountId, prompter, currentBase)
    }
    const progress = prompter.progress('Probing /agents/me…')
    const result = await validateApiKey(currentKey, { apiBase: currentBase })
    if (result.ok) {
      progress.stop(`Still authenticated as @${result.agent.handle}.`)
      return { cfg }
    }
    progress.stop('Key no longer works.')
    await prompter.note(`${result.message} [reason=${result.reason}]`, 'Re-validation failed')
    const doRotate = await prompter.confirm({
      message: 'Rotate to a new key now?',
      initialValue: true,
    })
    if (doRotate) return runNewAccountFlow(cfg, accountId, prompter, currentBase)
    return { cfg }
  }

  if (choice === 'rotate') {
    return runNewAccountFlow(cfg, accountId, prompter, currentBase)
  }

  // change-base
  const nextBase = await promptOptionalText(
    prompter,
    'New API base URL (blank to reset to default)',
    currentBase ?? 'https://api.agentchat.me',
  )
  if (nextBase) {
    try {
      const url = new URL(nextBase)
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        await prompter.note('API base must use http:// or https://. Not updated.', 'Ignored')
        return { cfg }
      }
    } catch {
      await prompter.note('Not a valid URL. API base not updated.', 'Ignored')
      return { cfg }
    }
  }
  const next = writeAccountPatch(cfg, accountId, { apiBase: nextBase || undefined })
  await prompter.note(
    nextBase ? `API base set to ${nextBase}` : 'API base reset to default',
    'Updated',
  )
  return { cfg: next }
}

async function runNewAccountFlow(
  cfg: OpenClawConfig,
  accountId: string,
  prompter: WizardPrompter,
  apiBase: string | undefined,
): Promise<{ cfg: OpenClawConfig }> {
  const choice = await prompter.select<'register' | 'have-key'>({
    message: 'How do you want to connect this agent?',
    options: [
      {
        value: 'register',
        label: 'Register a new agent (email + OTP)',
        hint: 'Mint a fresh API key — ~60 seconds',
      },
      {
        value: 'have-key',
        label: 'I already have an API key',
        hint: 'Paste ac_live_...',
      },
    ],
    initialValue: 'register',
  })
  if (choice === 'have-key') return runHaveKeyFlow(cfg, accountId, prompter, apiBase)
  return runRegisterFlow(cfg, accountId, prompter, apiBase)
}

// ─── The wizard ─────────────────────────────────────────────────────────

export const agentchatSetupWizard: ChannelSetupWizard = {
  channel: AGENTCHAT_CHANNEL_ID,

  resolveShouldPromptAccountIds: () => false,

  status: {
    configuredLabel: 'connected',
    unconfiguredLabel: 'needs API key',
    configuredHint: 'configured',
    unconfiguredHint: 'needs agent credentials',
    configuredScore: 2,
    unconfiguredScore: 0,
    resolveConfigured: ({ cfg, accountId }) => isAccountConfigured(cfg, accountId),
    resolveStatusLines: async ({ cfg, accountId, configured }) => {
      if (!configured) return ['AgentChat: needs API key — run setup to register or paste one']
      const id = accountId ?? AGENTCHAT_DEFAULT_ACCOUNT_ID
      const key = readAccountApiKey(cfg, id)
      const apiBase = readAccountApiBase(cfg, id)
      if (!key) return ['AgentChat: configured (no key visible)']
      try {
        const result = await validateApiKey(key, { apiBase, timeoutMs: 3000 })
        if (result.ok) return [`AgentChat: connected as @${result.agent.handle}`]
        return [`AgentChat: configured (live probe failed: ${result.reason})`]
      } catch {
        return ['AgentChat: configured (live probe unreachable)']
      }
    },
  },

  introNote: {
    title: 'AgentChat',
    lines: [
      'A messaging platform for AI agents — handle-based routing, realtime WebSocket,',
      'typed error taxonomy, idempotent sends.',
      '',
      'You can paste an existing API key, or register a new agent inline (email + OTP).',
    ],
  },

  prepare: async ({ cfg, accountId, credentialValues }) => {
    const flow: FlowKind = isAccountConfigured(cfg, accountId) ? 'edit' : 'new'
    return { credentialValues: { ...credentialValues, _flow: flow } }
  },

  credentials: [],

  finalize: async ({ cfg, accountId, prompter, credentialValues }) => {
    const rawFlow = credentialValues._flow
    const flow: FlowKind = rawFlow === 'edit' ? 'edit' : 'new'
    const apiBase = readAccountApiBase(cfg, accountId)
    return flow === 'edit'
      ? await runEditFlow(cfg, accountId, prompter)
      : await runNewAccountFlow(cfg, accountId, prompter, apiBase)
  },

  completionNote: {
    title: 'AgentChat is ready',
    lines: [
      'The channel runtime will auto-connect on the next `openclaw` boot.',
      'Messages addressed to your handle arrive over WebSocket; sends go out',
      'over HTTPS with at-least-once + idempotent semantics.',
    ],
  },

  disable: (cfg) => {
    const channels = {
      ...((cfg as { channels?: Record<string, unknown> } | undefined)?.channels ?? {}),
    }
    const existing = channels[AGENTCHAT_CHANNEL_ID]
    const section =
      existing && typeof existing === 'object' && !Array.isArray(existing)
        ? { ...(existing as Record<string, unknown>) }
        : ({} as Record<string, unknown>)
    section.enabled = false
    channels[AGENTCHAT_CHANNEL_ID] = section
    return { ...cfg, channels } as OpenClawConfig
  },
}

// Internal exports for unit tests (`agentchat-openclaw-channel/internal/wizard`
// is not a public export — these are deep-imported from test files only).
export const __testables = {
  readAccountApiKey,
  readAccountApiBase,
  writeAccountPatch,
  isAccountConfigured,
  describeRegisterStartFailure,
  describeRegisterVerifyFailure,
  runHaveKeyFlow,
  runRegisterFlow,
  runEditFlow,
  runNewAccountFlow,
}
