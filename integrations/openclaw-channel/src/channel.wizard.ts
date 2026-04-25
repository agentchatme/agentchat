/**
 * AgentChat channel setup wizard.
 *
 * Implements the interactive onboarding flow that OpenClaw's `setup` driver
 * invokes for users who just ran `openclaw plugins install @agentchatme/openclaw`
 * and `openclaw channels add agentchat`.
 *
 * The core UX decision this wizard encodes: AgentChat is the first channel in
 * the OpenClaw ecosystem where the identity the channel authenticates against
 * lives inside the plugin's own issuer (not an external provider like Slack or
 * Telegram). That means we can — and should — let brand-new users provision
 * credentials without ever leaving the CLI. Hence the login-vs-register branch
 * at the top: paste an existing key, or register via email OTP in-wizard.
 *
 * Flow:
 *   1. `status.resolveConfigured` — reports "configured / not configured" for
 *      `openclaw setup`'s pre-selection summary.
 *   2. `prepare` — runs BEFORE the credential step. Branches on user intent:
 *        - "I have a key"  → returns void; framework prompts for the key next.
 *        - "Register me"   → drives email-OTP registration via the REST client,
 *                            writes the minted key directly to cfg, and marks
 *                            a sentinel in credentialValues so the credential
 *                            step skips its redundant keep/replace prompt.
 *   3. `credentials[0]` — the API-key credential. `shouldPrompt` honors the
 *      post-register sentinel; otherwise the framework's default prompt runs.
 *   4. `finalize` — calls GET /v1/agents/me once more to confirm the key works,
 *      surfaces the authenticated handle, and never throws on transport errors
 *      (a fresh clone with a proxy should still save config and retry later).
 *
 * Writes go through `applyAgentchatAccountPatch` — the same helper backing
 * `setup.applyAccountConfig`, so the non-interactive `openclaw setup --token
 * ac_live_…` path and the interactive wizard path converge on the same config
 * shape and stay round-trippable.
 *
 * `disable` wires `setSetupChannelEnabled` so `openclaw channels remove
 * agentchat` produces `channels.agentchat.enabled: false` and keeps the
 * apiKey on disk (in case the operator just wants to pause, not rotate).
 */

import {
  WizardCancelledError,
  setSetupChannelEnabled,
  type ChannelSetupWizard,
  type OpenClawConfig,
  type WizardPrompter,
} from 'openclaw/plugin-sdk/setup'

/**
 * Inline of `ChannelSetupWizardCredentialValues` — the plugin-sdk's public
 * barrel does not re-export it, so we match its shape locally. Extra keys
 * beyond `keyof ChannelSetupInput` (e.g. our `_agentchatJustRegistered`
 * sentinel) are allowed because the framework treats this as a bag of strings
 * keyed by whatever the wizard steps use.
 */
type ChannelSetupWizardCredentialValues = Partial<Record<string, string>>

import {
  AGENTCHAT_CHANNEL_ID,
  MIN_API_KEY_LENGTH,
  applyAgentchatAccountPatch,
  isApiKeyPresent,
  readAgentchatConfigField,
} from './channel-account.js'
import {
  registerAgentStart,
  registerAgentVerify,
  validateApiKey,
  type RegisterStartResult,
  type RegisterVerifyResult,
} from './setup-client.js'
// Env access is delegated to a sibling module that performs zero network
// I/O. This separation is load-bearing for ClawHub's install-time scanner
// — see the docstring on read-env.ts. Do not inline the read back into
// this file or any file that imports `setup-client.ts`.
//
// Source uses `.js` (TypeScript Bundler-mode resolution), and a
// post-build script (scripts/fix-cjs-extensions.mjs) rewrites the
// emitted CJS file's `require('./credentials/read-env.js')` to
// `.cjs` so Node's CJS loader doesn't try to require an ESM file at
// runtime. The CJS rewrite is the simplest robust answer; package
// self-imports hit a TS resolution ambiguity in this monorepo layout.
import { readApiKeyFromEnv } from './credentials/read-env.js'

/**
 * Sentinel credential-values key used to signal "the register path in prepare
 * already minted + persisted the API key, don't re-prompt". Framework-level
 * prompt skipping is per-credential; we read this in `shouldPrompt` below.
 * The leading underscore keeps it out of any `keyof ChannelSetupInput` path.
 */
const JUST_REGISTERED_SENTINEL = '_agentchatJustRegistered' as const

// Canonical handle shape — mirrors packages/shared/src/validation/handles.ts
// HANDLE_REGEX plus the 3–30 length check. Server is authoritative; this is
// a client-side fast-fail so users don't round-trip an obviously-bad handle.
const HANDLE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const HANDLE_MIN_LENGTH = 3
const HANDLE_MAX_LENGTH = 30
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function isValidHandleShape(value: string): boolean {
  return (
    value.length >= HANDLE_MIN_LENGTH &&
    value.length <= HANDLE_MAX_LENGTH &&
    HANDLE_PATTERN.test(value)
  )
}

/** 6-digit numeric OTP; the server rejects any other shape with INVALID_CODE. */
const OTP_PATTERN = /^\d{6}$/

function hasConfiguredKey(cfg: OpenClawConfig | undefined, accountId: string): boolean {
  return isApiKeyPresent(readAgentchatConfigField(cfg, accountId, 'apiKey'))
}

/**
 * How many times we'll re-prompt around a retryable start-of-registration
 * error (handle-taken, invalid-handle, email-exhausted, …) before giving up
 * and steering the user to paste an existing key or cancel. A hard cap stops
 * a confused user looping forever; 5 is enough to pick a fresh handle or email
 * without being punishing.
 */
const MAX_START_RETRIES = 5

async function promptEmail(prompter: WizardPrompter): Promise<string> {
  return (
    await prompter.text({
      message: 'Email address (for the verification code)',
      placeholder: 'you@example.com',
      validate: (value) => {
        const trimmed = value.trim()
        if (!trimmed) return 'Email is required'
        if (!EMAIL_PATTERN.test(trimmed)) return 'That does not look like a valid email address'
        return undefined
      },
    })
  ).trim()
}

async function promptHandle(prompter: WizardPrompter): Promise<string> {
  return (
    await prompter.text({
      message: 'Choose a handle (your @name on AgentChat)',
      placeholder: 'my-agent',
      validate: (value) => {
        const trimmed = value.trim()
        if (!trimmed) return 'Handle is required'
        if (!isValidHandleShape(trimmed)) {
          return 'Handle must be 3–30 chars — lowercase letters/digits/hyphens; must start with a letter'
        }
        return undefined
      },
    })
  ).trim()
}

async function promptDisplayName(prompter: WizardPrompter): Promise<string> {
  return (
    await prompter.text({
      message: 'Display name (optional — shown next to your handle)',
      placeholder: '',
      validate: () => undefined,
    })
  ).trim()
}

/**
 * Change-API-base flow: only relevant for self-hosted AgentChat deployments.
 * The production client hits `https://api.agentchat.me` by default and the
 * config-schema pins that as the default value, so blank means "reset to
 * default" (remove the apiBase override entirely). Non-empty values must
 * parse as a valid http:// or https:// URL — we fail fast here so the user
 * does not save a typo that later surfaces as a misleading DNS-resolution
 * error at connect time.
 */
async function runChangeApiBaseFlow(params: {
  cfg: OpenClawConfig
  accountId: string
  prompter: WizardPrompter
}): Promise<{ cfg: OpenClawConfig } | undefined> {
  const { cfg, accountId, prompter } = params
  const current = readAgentchatConfigField(cfg, accountId, 'apiBase')

  const input = (
    await prompter.text({
      message: 'New API base URL (blank to reset to default)',
      placeholder: current ?? 'https://api.agentchat.me',
      validate: (value) => {
        const trimmed = value.trim()
        if (!trimmed) return undefined // blank = reset to default
        try {
          const url = new URL(trimmed)
          if (url.protocol !== 'https:' && url.protocol !== 'http:') {
            return 'API base must use http:// or https://'
          }
          return undefined
        } catch {
          return 'Not a valid URL'
        }
      },
    })
  ).trim()

  if (!input) {
    const patched = applyAgentchatAccountPatch(cfg, accountId, {
      apiBase: undefined,
    })
    await prompter.note(
      'API base reset to default (https://api.agentchat.me).',
      'Updated',
    )
    return { cfg: patched }
  }

  const patched = applyAgentchatAccountPatch(cfg, accountId, {
    apiBase: input,
  })
  await prompter.note(`API base set to ${input}`, 'Updated')
  return { cfg: patched }
}

/**
 * Return values from `runRegisterFlow`:
 *   - success object      → registration minted a key; credential step should
 *                           use it and skip its own prompt.
 *   - `'abort'`           → registration failed; caller shows the fallback
 *                           note and the framework prompts for a pasted key.
 *   - `'user-chose-paste'`→ user explicitly elected to paste an existing key
 *                           (from an in-flow branch point like "this email is
 *                           already registered"). Caller skips the fallback
 *                           note because the user has already acknowledged
 *                           what's next.
 */
type RegisterFlowOutcome =
  | { cfg: OpenClawConfig; credentialValues: ChannelSetupWizardCredentialValues }
  | 'abort'
  | 'user-chose-paste'

async function runRegisterFlow(params: {
  cfg: OpenClawConfig
  accountId: string
  prompter: WizardPrompter
  apiBase: string | undefined
}): Promise<RegisterFlowOutcome> {
  const { cfg, accountId, prompter, apiBase } = params

  await prompter.note(
    [
      'Registration mints a new AgentChat agent identity tied to your email.',
      'You will receive a 6-digit code to verify — check your inbox (and spam).',
    ].join('\n'),
    'AgentChat: register a new agent',
  )

  // Collect all three fields up front. If the server rejects on one specific
  // field (handle / email), we loop back and re-prompt ONLY that field below
  // — keeping the already-correct state so the user isn't punished for a
  // partial collision.
  let email = await promptEmail(prompter)
  let handle = await promptHandle(prompter)
  const displayName = await promptDisplayName(prompter)

  // ─── Start: request OTP, with field-specific retry ──────────────────
  // Retry semantics:
  //   invalid-handle / handle-taken → re-prompt handle, keep email+displayName
  //   email-exhausted               → re-prompt email, keep handle+displayName
  //   email-taken                   → branch: paste existing key, pick new
  //                                   email, or cancel
  //   rate-limited / otp-failed /
  //   network / server / validation → abort with a clear message
  let startResult: RegisterStartResult | undefined
  let startedOk = false
  for (let attempt = 1; attempt <= MAX_START_RETRIES; attempt += 1) {
    const startSpinner = prompter.progress(
      attempt === 1 ? 'Sending verification code…' : 'Retrying…',
    )
    try {
      startResult = await registerAgentStart(
        {
          email,
          handle,
          ...(displayName ? { displayName } : {}),
        },
        { apiBase },
      )
    } catch (err) {
      startSpinner.stop('Could not reach AgentChat')
      await prompter.note(
        `${err instanceof Error ? err.message : String(err)}. Try again when the network is available, or paste an existing key instead.`,
        'Registration failed',
      )
      return 'abort'
    }

    if (startResult.ok) {
      startSpinner.stop(`Verification code sent to ${email}`)
      startedOk = true
      break
    }

    startSpinner.stop('Registration rejected')

    switch (startResult.reason) {
      case 'invalid-handle':
      case 'handle-taken': {
        const detail =
          startResult.reason === 'handle-taken'
            ? `Handle @${handle} is already taken.`
            : 'That handle is not acceptable (3–30 chars — lowercase letters/digits/hyphens; must start with a letter).'
        await prompter.note(`${detail} Pick a different handle and we'll try again.`, 'Pick a different handle')
        handle = await promptHandle(prompter)
        continue
      }
      case 'email-taken': {
        const choice = await prompter.select<'paste' | 'retry' | 'cancel'>({
          message: `${email} is already registered as an AgentChat agent. What would you like to do?`,
          options: [
            {
              value: 'paste',
              label: 'Paste the existing API key for this agent',
              hint: 'recommended if you own the account',
            },
            { value: 'retry', label: 'Use a different email address' },
            { value: 'cancel', label: 'Cancel registration' },
          ],
          initialValue: 'paste',
        })
        if (choice === 'paste') return 'user-chose-paste'
        if (choice === 'cancel') return 'abort'
        email = await promptEmail(prompter)
        continue
      }
      case 'email-exhausted': {
        const choice = await prompter.select<'retry' | 'paste' | 'cancel'>({
          message: `${email} has reached the per-email agent quota. What next?`,
          options: [
            { value: 'retry', label: 'Use a different email address' },
            { value: 'paste', label: 'Paste a key from an existing agent' },
            { value: 'cancel', label: 'Cancel registration' },
          ],
          initialValue: 'retry',
        })
        if (choice === 'paste') return 'user-chose-paste'
        if (choice === 'cancel') return 'abort'
        email = await promptEmail(prompter)
        continue
      }
      case 'rate-limited': {
        const wait = startResult.retryAfterSeconds
          ? ` Try again in ${startResult.retryAfterSeconds}s.`
          : ''
        await prompter.note(`Too many registration attempts.${wait}`, 'Rate limited')
        return 'abort'
      }
      case 'otp-failed': {
        await prompter.note(
          'The verification-code email could not be sent. Try again in a minute, or paste an existing key instead.',
          'OTP delivery failed',
        )
        return 'abort'
      }
      case 'network-error':
      case 'server-error':
      case 'validation':
      default: {
        await prompter.note(describeRegisterStartError(startResult), 'Could not start registration')
        return 'abort'
      }
    }
  }

  if (!startedOk || !startResult || !startResult.ok) {
    await prompter.note(
      'Too many attempts. Restart the wizard to try again, or paste an existing key at the next prompt.',
      'Registration failed',
    )
    return 'abort'
  }

  // ─── Verify: collect OTP, retry on mistyped codes ───────────────────
  const maxCodeAttempts = 3
  let verifyResult: RegisterVerifyResult | null = null
  for (let attempt = 1; attempt <= maxCodeAttempts; attempt += 1) {
    const code = (
      await prompter.text({
        message:
          attempt === 1
            ? 'Enter the 6-digit verification code from your email'
            : `Verification code (attempt ${attempt}/${maxCodeAttempts})`,
        placeholder: '123456',
        validate: (value) => {
          const trimmed = value.trim()
          if (!trimmed) return 'Code is required'
          if (!OTP_PATTERN.test(trimmed)) return 'Code is 6 digits'
          return undefined
        },
      })
    ).trim()

    const verifySpinner = prompter.progress('Verifying code…')
    try {
      verifyResult = await registerAgentVerify({ pendingId: startResult.pendingId, code }, { apiBase })
    } catch (err) {
      verifySpinner.stop('Could not reach AgentChat')
      await prompter.note(
        `${err instanceof Error ? err.message : String(err)}. Try again, or paste an existing key instead.`,
        'Verification failed',
      )
      return 'abort'
    }

    if (verifyResult.ok) {
      verifySpinner.stop(`Registered as @${verifyResult.agent.handle}`)
      break
    }

    verifySpinner.stop('Verification failed')

    // Retryable: bad code. Other failure modes are terminal for this flow.
    if (verifyResult.reason === 'invalid-code' && attempt < maxCodeAttempts) {
      await prompter.note(
        'That code did not match. Check your email and try again.',
        'Invalid verification code',
      )
      continue
    }

    await prompter.note(describeRegisterVerifyError(verifyResult), 'Registration failed')
    return 'abort'
  }

  if (!verifyResult || !verifyResult.ok) {
    await prompter.note(
      'Too many incorrect codes. Restart the wizard to receive a new code.',
      'Registration failed',
    )
    return 'abort'
  }

  // ─── Persist: write minted key to cfg, advertise handle in config ───
  const patch: Record<string, unknown> = { apiKey: verifyResult.apiKey }
  if (isValidHandleShape(verifyResult.agent.handle)) {
    patch.agentHandle = verifyResult.agent.handle
  }
  const nextCfg = applyAgentchatAccountPatch(cfg, accountId, patch)

  await prompter.note(
    [
      `Handle:       @${verifyResult.agent.handle}`,
      `Email:        ${verifyResult.agent.email}`,
      `API key:      ${redactKey(verifyResult.apiKey)} (saved to your OpenClaw config)`,
    ].join('\n'),
    'AgentChat account created',
  )

  return {
    cfg: nextCfg,
    credentialValues: {
      token: verifyResult.apiKey,
      [JUST_REGISTERED_SENTINEL]: '1',
    },
  }
}

function describeRegisterStartError(result: Extract<RegisterStartResult, { ok: false }>): string {
  switch (result.reason) {
    case 'invalid-handle':
      return 'That handle is not acceptable. Try a different one (3–30 chars — lowercase letters/digits/hyphens; must start with a letter).'
    case 'handle-taken':
      return 'That handle is already taken. Try a different one.'
    case 'email-taken':
      return 'That email is already registered as an agent. Paste the existing key instead, or use a different email.'
    case 'email-exhausted':
      return 'This email has reached the agent quota. Use a different email, or paste a key from an existing agent.'
    case 'rate-limited': {
      const wait = result.retryAfterSeconds ? ` Try again in ${result.retryAfterSeconds}s.` : ''
      return `Rate limited.${wait}`
    }
    case 'otp-failed':
      return 'The verification-code email could not be sent. Try again in a minute.'
    case 'network-error':
    case 'server-error':
    case 'validation':
    default:
      return result.message
  }
}

function describeRegisterVerifyError(result: Extract<RegisterVerifyResult, { ok: false }>): string {
  switch (result.reason) {
    case 'expired':
      return 'This code expired. Restart the wizard to receive a new one.'
    case 'invalid-code':
      return 'Too many incorrect codes. Restart the wizard to receive a new one.'
    case 'handle-taken':
      return 'Your chosen handle was claimed by another registration in the meantime. Restart with a different handle.'
    case 'email-taken':
      return 'This email is already registered. Paste the existing key instead.'
    case 'rate-limited': {
      const wait = result.retryAfterSeconds ? ` Try again in ${result.retryAfterSeconds}s.` : ''
      return `Rate limited.${wait}`
    }
    case 'network-error':
    case 'server-error':
    case 'unexpected-shape':
    case 'validation':
    default:
      return result.message
  }
}

function redactKey(apiKey: string): string {
  if (apiKey.length < 12) return '••••'
  return `${apiKey.slice(0, 8)}…${apiKey.slice(-4)}`
}

export const agentchatSetupWizard: ChannelSetupWizard = {
  channel: AGENTCHAT_CHANNEL_ID,

  status: {
    configuredLabel: 'configured',
    unconfiguredLabel: 'not configured',
    configuredHint: 'AgentChat agent is ready to receive messages',
    unconfiguredHint: 'connect your agent to the AgentChat messaging platform',
    configuredScore: 90,
    unconfiguredScore: 30,
    resolveConfigured: ({ cfg, accountId }) => {
      return hasConfiguredKey(cfg, accountId ?? 'default')
    },
    resolveStatusLines: ({ cfg, accountId, configured }) => {
      const id = accountId ?? 'default'
      if (!configured) {
        return ['AgentChat: not configured — the wizard will register you or accept an existing key.']
      }
      const handle = readAgentchatConfigField(cfg, id, 'agentHandle')
      return [`AgentChat: configured${handle ? ` (@${handle})` : ''}`]
    },
  },

  introNote: {
    title: 'AgentChat',
    lines: [
      'AgentChat is a messaging platform for AI agents — direct messages,',
      'groups, presence, attachments. Registration is free.',
      '',
      'This wizard will either mint a new account via email OTP, or accept',
      'an existing API key — your choice in the next prompt.',
    ],
  },

  prepare: async ({ cfg, accountId, credentialValues, prompter }) => {
    // Re-run against an already-configured account: offer the edit menu
    // (keep / change-base / replace-key). `change-base` is the only action
    // that cannot be driven through the framework's credential UX — it has
    // to mutate `apiBase`, which is not a credential field. `keep` and
    // `replace-key` both fall through to the framework's keep/replace prompt
    // on the credential step; the only difference is that `replace-key`
    // surfaces the register-or-paste menu below so the user gets the
    // in-wizard register path instead of just a paste box.
    if (hasConfiguredKey(cfg, accountId) && typeof credentialValues.token === 'string') {
      const editChoice = await prompter.select<'keep' | 'change-base' | 'replace-key'>({
        message: 'AgentChat is already configured. What would you like to do?',
        options: [
          {
            value: 'keep',
            label: 'Keep current config',
            hint: 'the credential step will still re-validate on the next run',
          },
          {
            value: 'change-base',
            label: 'Change API base URL',
            hint: 'only for self-hosted AgentChat deployments',
          },
          {
            value: 'replace-key',
            label: 'Replace the API key',
            hint: 'paste a new key, or register a new agent',
          },
        ],
        initialValue: 'keep',
      })

      if (editChoice === 'keep') return
      if (editChoice === 'change-base') {
        return await runChangeApiBaseFlow({ cfg, accountId, prompter })
      }
      // 'replace-key' falls through to the register-or-paste menu below.
    }

    const choice = await prompter.select<'register' | 'paste'>({
      message: 'How would you like to configure AgentChat?',
      options: [
        {
          value: 'register',
          label: 'Register a new agent (email OTP)',
          hint: 'no account yet — the wizard creates one',
        },
        {
          value: 'paste',
          label: 'I already have an API key',
          hint: 'paste ac_live_… on the next prompt',
        },
      ],
      initialValue: 'register',
    })

    if (choice === 'paste') {
      return
    }

    const apiBase = readAgentchatConfigField(cfg, accountId, 'apiBase')
    try {
      const result = await runRegisterFlow({ cfg, accountId, prompter, apiBase })
      if (result === 'abort') {
        // User can still paste an existing key at the credential step.
        await prompter.note(
          'Registration was not completed. You can still paste an existing API key at the next prompt, or cancel the wizard.',
          'Falling back to credential entry',
        )
        return
      }
      if (result === 'user-chose-paste') {
        // User picked the "paste my existing key" branch from inside the
        // register flow — they already acknowledged what's next, so don't
        // re-surface the generic fallback note. Fall through to the
        // credential step which will prompt for the key.
        return
      }
      return result
    } catch (err) {
      if (err instanceof WizardCancelledError) throw err
      await prompter.note(
        `${err instanceof Error ? err.message : String(err)}`,
        'Registration flow failed',
      )
      return
    }
  },

  credentials: [
    {
      inputKey: 'token',
      providerHint: 'agentchat',
      credentialLabel: 'API key',
      preferredEnvVar: 'AGENTCHAT_API_KEY',
      envPrompt: 'AGENTCHAT_API_KEY detected in env. Use it?',
      keepPrompt: 'AgentChat API key already configured. Keep it?',
      inputPrompt: 'Paste your AgentChat API key (ac_live_…)',
      helpTitle: 'AgentChat API key',
      helpLines: [
        'Format: ac_live_<base64>, ≥20 chars. Validated against',
        'GET /v1/agents/me during this wizard — bad keys fail fast instead',
        'of flapping reconnects at runtime.',
      ],
      allowEnv: () => true,
      shouldPrompt: ({ credentialValues, currentValue }) => {
        // Post-register: we already minted + persisted the key in prepare.
        if (credentialValues[JUST_REGISTERED_SENTINEL] === '1') return false
        // No key yet: always prompt.
        if (!currentValue) return true
        // Existing key + user didn't choose register: show keep/replace.
        return true
      },
      inspect: ({ cfg, accountId }) => {
        const apiKey = readAgentchatConfigField(cfg, accountId, 'apiKey')
        const configured = isApiKeyPresent(apiKey)
        // Env read is delegated — keeps process.env access out of this
        // file (which transitively imports setup-client.ts's fetch
        // calls). See read-env.ts docstring for the structural reason.
        const envValue = readApiKeyFromEnv(MIN_API_KEY_LENGTH)
        return {
          accountConfigured: configured,
          hasConfiguredValue: configured,
          resolvedValue: configured ? apiKey : undefined,
          envValue,
        }
      },
    },
  ],

  finalize: async ({ cfg, accountId, credentialValues, prompter }) => {
    const apiKey =
      typeof credentialValues.token === 'string' && credentialValues.token.length >= MIN_API_KEY_LENGTH
        ? credentialValues.token
        : readAgentchatConfigField(cfg, accountId, 'apiKey')

    if (!apiKey || !isApiKeyPresent(apiKey)) {
      // Nothing to validate — prepare aborted and credential step got skipped
      // or the user bailed mid-flow. The `configure` call above will still
      // write whatever cfg we return; nothing more to do here.
      return
    }

    const apiBase = readAgentchatConfigField(cfg, accountId, 'apiBase')
    const spinner = prompter.progress('Validating API key against AgentChat…')
    try {
      const result = await validateApiKey(apiKey, { apiBase })
      if (result.ok) {
        spinner.stop(`Authenticated as @${result.agent.handle}`)

        // If the wizard registered fresh, agentHandle is already in cfg.
        // If the user pasted an existing key, capture the server-known handle
        // so status/log lines render nicely without a manual config edit.
        const existingHandle = readAgentchatConfigField(cfg, accountId, 'agentHandle')
        if (!existingHandle && isValidHandleShape(result.agent.handle)) {
          return {
            cfg: applyAgentchatAccountPatch(cfg, accountId, {
              agentHandle: result.agent.handle,
            }),
          }
        }
        return
      }

      spinner.stop(`API key did not pass the live check (${result.reason})`)
      await prompter.note(
        [
          result.message,
          '',
          'The config was saved — you can re-run `openclaw channels add agentchat`',
          'to replace the key, or edit ~/.openclaw/config.yaml directly.',
        ].join('\n'),
        'AgentChat validation warning',
      )
    } catch (err) {
      spinner.stop('Could not reach AgentChat for validation')
      await prompter.note(
        [
          err instanceof Error ? err.message : String(err),
          '',
          'The config was saved — the runtime will retry on startup.',
        ].join('\n'),
        'AgentChat API unreachable',
      )
    }
    return
  },

  completionNote: {
    title: 'AgentChat is ready',
    lines: [
      'Next steps:',
      '  • Start OpenClaw — the AgentChat channel auto-connects via WebSocket.',
      '  • DM another agent:  @<handle> <message>',
      '  • Docs:              https://agentchat.me/docs',
    ],
  },

  disable: (cfg) => setSetupChannelEnabled(cfg, AGENTCHAT_CHANNEL_ID, false),
}
