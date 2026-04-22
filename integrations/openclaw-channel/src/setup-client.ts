/**
 * Minimal HTTP client used by the setup plugin (P7) to:
 *   - verify an API key is live before finalizing setup (`validateApiKey`)
 *   - drive the email-OTP self-registration flow for agents without a key yet
 *     (`registerAgentStart` → `registerAgentVerify`)
 *
 * Why this lives separately from `outbound.ts`:
 *   - `outbound.ts` is the hot-path message sender. It wants retries, a circuit
 *     breaker, metrics, and a long-lived `fetch`. Setup is one-shot, low-rate,
 *     user-interactive — a 200ms validation call doesn't need any of that.
 *   - Setup runs before the runtime exists; coupling it to `OutboundAdapter`
 *     (which expects a parsed `AgentchatChannelConfig`) would force an odd
 *     partial-config path during registration.
 *
 * The server endpoints this module targets are stable AgentChat REST calls:
 *   - `GET  /v1/agents/me`          → 200 OK when the key authenticates
 *   - `POST /v1/register`           → 200 with `{ pending_id }`
 *   - `POST /v1/register/verify`    → 201 with `{ agent, api_key }` on success
 *
 * All methods return strongly-typed result unions — setup UIs can `switch` on
 * the discriminant without guessing at HTTP status codes.
 */

import { AgentChatChannelError } from './errors.js'

const DEFAULT_API_BASE = 'https://api.agentchat.me'
const DEFAULT_TIMEOUT_MS = 10_000

/** Subset of the AgentChat agent row the setup surface needs to show the user. */
export interface AgentchatAgentIdentity {
  readonly handle: string
  readonly displayName: string | null
  readonly email: string
  readonly createdAt: string
}

export type ValidateApiKeyResult =
  | { readonly ok: true; readonly agent: AgentchatAgentIdentity }
  | {
      readonly ok: false
      /** High-level reason code the UI can map to a localized message. */
      readonly reason:
        | 'unauthorized'
        | 'forbidden'
        | 'deleted'
        | 'network-error'
        | 'unreachable'
        | 'server-error'
        | 'unexpected-shape'
      readonly message: string
      readonly status?: number
    }

export interface ValidateApiKeyOptions {
  readonly apiBase?: string
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
}

/**
 * Probe the API key against `GET /v1/agents/me`. Returns a discriminated
 * result — never throws on HTTP or network errors. The caller decides how
 * to surface each failure mode to the user.
 */
export async function validateApiKey(
  apiKey: string,
  opts: ValidateApiKeyOptions = {},
): Promise<ValidateApiKeyResult> {
  if (!apiKey || typeof apiKey !== 'string') {
    return { ok: false, reason: 'unauthorized', message: 'API key is empty' }
  }
  const base = (opts.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '')
  const url = `${base}/v1/agents/me`
  const controller = new AbortController()
  const fetchImpl = opts.fetch ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const unreachable =
      err instanceof Error &&
      (err.name === 'AbortError' || /ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(message))
    return {
      ok: false,
      reason: unreachable ? 'unreachable' : 'network-error',
      message: `agentchat: GET /v1/agents/me failed: ${message}`,
    }
  } finally {
    clearTimeout(timer)
  }

  if (res.status === 401) {
    return { ok: false, reason: 'unauthorized', status: 401, message: 'API key is invalid or revoked' }
  }
  if (res.status === 403) {
    return { ok: false, reason: 'forbidden', status: 403, message: 'API key lacks permission to read /agents/me' }
  }
  if (res.status === 410) {
    return { ok: false, reason: 'deleted', status: 410, message: 'Agent account has been deleted' }
  }
  if (res.status >= 500) {
    return { ok: false, reason: 'server-error', status: res.status, message: `AgentChat API returned ${res.status}` }
  }
  if (!res.ok) {
    return {
      ok: false,
      reason: 'server-error',
      status: res.status,
      message: `AgentChat API returned ${res.status}`,
    }
  }

  const body = (await res.json().catch(() => null)) as {
    handle?: unknown
    display_name?: unknown
    email?: unknown
    email_masked?: unknown
    created_at?: unknown
  } | null
  // The live `GET /v1/agents/me` endpoint masks PII: it returns
  // `email_masked` (e.g. `a****@agentchat.local`), never the real `email`.
  // Accept either so tests that stub an unmasked body still pass, but the
  // caller should expect a masked value in production.
  const email =
    typeof body?.email === 'string'
      ? body.email
      : typeof body?.email_masked === 'string'
        ? body.email_masked
        : null
  if (!body || typeof body.handle !== 'string' || email === null || typeof body.created_at !== 'string') {
    return {
      ok: false,
      reason: 'unexpected-shape',
      status: res.status,
      message: 'AgentChat /agents/me returned an unrecognized shape',
    }
  }
  return {
    ok: true,
    agent: {
      handle: body.handle,
      displayName: typeof body.display_name === 'string' ? body.display_name : null,
      email,
      createdAt: body.created_at,
    },
  }
}

// ─── Self-registration (email + OTP) ───────────────────────────────────

export interface RegisterAgentStartInput {
  readonly email: string
  readonly handle: string
  readonly displayName?: string
  readonly description?: string
}

export type RegisterStartResult =
  | { readonly ok: true; readonly pendingId: string }
  | {
      readonly ok: false
      readonly reason:
        | 'invalid-handle'
        | 'handle-taken'
        | 'email-taken'
        | 'email-exhausted'
        | 'rate-limited'
        | 'otp-failed'
        | 'network-error'
        | 'server-error'
        | 'validation'
      readonly message: string
      readonly status?: number
      readonly retryAfterSeconds?: number
    }

export interface RegisterAgentVerifyInput {
  readonly pendingId: string
  readonly code: string
}

export type RegisterVerifyResult =
  | {
      readonly ok: true
      readonly apiKey: string
      readonly agent: AgentchatAgentIdentity
    }
  | {
      readonly ok: false
      readonly reason:
        | 'expired'
        | 'invalid-code'
        | 'rate-limited'
        | 'handle-taken'
        | 'email-taken'
        | 'network-error'
        | 'server-error'
        | 'unexpected-shape'
        | 'validation'
      readonly message: string
      readonly status?: number
      readonly retryAfterSeconds?: number
    }

export interface RegisterOptions {
  readonly apiBase?: string
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
}

/**
 * Kick off an email-OTP registration. Server caches the intent under a
 * `pending_id` for 10 minutes and emails a 6-digit code to `email`.
 */
export async function registerAgentStart(
  input: RegisterAgentStartInput,
  opts: RegisterOptions = {},
): Promise<RegisterStartResult> {
  const res = await post('/v1/register', input, opts)
  if (res.kind === 'network') {
    return { ok: false, reason: 'network-error', message: res.message }
  }
  if (res.kind === 'timeout') {
    return { ok: false, reason: 'network-error', message: 'request timed out' }
  }

  const body = (res.body as { pending_id?: unknown; code?: unknown; message?: unknown }) ?? {}

  if (res.status === 200) {
    if (typeof body.pending_id !== 'string') {
      return {
        ok: false,
        reason: 'server-error',
        status: 200,
        message: 'AgentChat /register returned no pending_id',
      }
    }
    return { ok: true, pendingId: body.pending_id }
  }

  const code = typeof body.code === 'string' ? body.code : ''
  const message = typeof body.message === 'string' ? body.message : `status ${res.status}`

  if (res.status === 400 && code === 'INVALID_HANDLE') return { ok: false, reason: 'invalid-handle', message, status: 400 }
  if (res.status === 400 && code === 'VALIDATION_ERROR') return { ok: false, reason: 'validation', message, status: 400 }
  if (res.status === 409 && code === 'HANDLE_TAKEN') return { ok: false, reason: 'handle-taken', message, status: 409 }
  if (res.status === 409 && code === 'EMAIL_TAKEN') return { ok: false, reason: 'email-taken', message, status: 409 }
  if (res.status === 409 && code === 'EMAIL_EXHAUSTED') return { ok: false, reason: 'email-exhausted', message, status: 409 }
  if (res.status === 429) {
    return {
      ok: false,
      reason: 'rate-limited',
      message,
      status: 429,
      retryAfterSeconds: res.retryAfterSeconds,
    }
  }
  if (res.status >= 500 || code === 'OTP_FAILED') return { ok: false, reason: 'otp-failed', message, status: res.status }
  return { ok: false, reason: 'server-error', status: res.status, message }
}

/** Verify the OTP the user received by email and mint the API key. */
export async function registerAgentVerify(
  input: RegisterAgentVerifyInput,
  opts: RegisterOptions = {},
): Promise<RegisterVerifyResult> {
  const res = await post('/v1/register/verify', { pending_id: input.pendingId, code: input.code }, opts)
  if (res.kind === 'network') return { ok: false, reason: 'network-error', message: res.message }
  if (res.kind === 'timeout') return { ok: false, reason: 'network-error', message: 'request timed out' }

  const body = (res.body ?? {}) as {
    code?: unknown
    message?: unknown
    agent?: { handle?: unknown; display_name?: unknown; email?: unknown; created_at?: unknown }
    api_key?: unknown
  }

  if (res.status === 201) {
    const agent = body.agent
    if (
      typeof body.api_key !== 'string' ||
      !agent ||
      typeof agent.handle !== 'string' ||
      typeof agent.email !== 'string' ||
      typeof agent.created_at !== 'string'
    ) {
      return {
        ok: false,
        reason: 'unexpected-shape',
        status: 201,
        message: 'AgentChat /register/verify returned an unrecognized shape',
      }
    }
    return {
      ok: true,
      apiKey: body.api_key,
      agent: {
        handle: agent.handle,
        displayName: typeof agent.display_name === 'string' ? agent.display_name : null,
        email: agent.email,
        createdAt: agent.created_at,
      },
    }
  }

  const code = typeof body.code === 'string' ? body.code : ''
  const message = typeof body.message === 'string' ? body.message : `status ${res.status}`

  if (res.status === 400 && code === 'EXPIRED') return { ok: false, reason: 'expired', message, status: 400 }
  if (res.status === 400 && code === 'INVALID_CODE') return { ok: false, reason: 'invalid-code', message, status: 400 }
  if (res.status === 400 && code === 'VALIDATION_ERROR') return { ok: false, reason: 'validation', message, status: 400 }
  if (res.status === 409 && code === 'HANDLE_TAKEN') return { ok: false, reason: 'handle-taken', message, status: 409 }
  if (res.status === 409 && code === 'EMAIL_TAKEN') return { ok: false, reason: 'email-taken', message, status: 409 }
  if (res.status === 429) {
    return { ok: false, reason: 'rate-limited', message, status: 429, retryAfterSeconds: res.retryAfterSeconds }
  }
  return { ok: false, reason: 'server-error', status: res.status, message }
}

// ─── Internals ─────────────────────────────────────────────────────────

type PostOutcome =
  | { kind: 'http'; status: number; body: unknown; retryAfterSeconds?: number }
  | { kind: 'network'; message: string }
  | { kind: 'timeout' }

async function post(path: string, body: unknown, opts: RegisterOptions): Promise<PostOutcome> {
  const base = (opts.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '')
  const url = `${base}${path}`
  const controller = new AbortController()
  const fetchImpl = opts.fetch ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const parsed = await res.json().catch(() => null)
    const retryAfterHeader = res.headers.get('retry-after')
    const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined
    return {
      kind: 'http',
      status: res.status,
      body: parsed,
      retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return { kind: 'timeout' }
    return { kind: 'network', message: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Throw-flavored wrapper used by callers that prefer exception control flow
 * (the setup plugin's `afterAccountConfigWritten` hook). Converts a failure
 * result into an `AgentChatChannelError` with an appropriate class.
 */
export async function assertApiKeyValid(
  apiKey: string,
  opts: ValidateApiKeyOptions = {},
): Promise<AgentchatAgentIdentity> {
  const result = await validateApiKey(apiKey, opts)
  if (result.ok) return result.agent
  const class_ =
    result.reason === 'unauthorized' || result.reason === 'forbidden' || result.reason === 'deleted'
      ? 'terminal-auth'
      : result.reason === 'server-error'
        ? 'retry-transient'
        : 'retry-transient'
  throw new AgentChatChannelError(class_, `${result.message} [reason=${result.reason}]`, {
    statusCode: result.status,
  })
}
