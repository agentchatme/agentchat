import {
  AgentChatError,
  ConnectionError,
  createAgentChatError,
  type AgentChatErrorResponse,
} from './errors.js'
import { parseRetryAfter } from './http-retry-after.js'
import { defaultUserAgent } from './runtime.js'

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/**
 * Header the server emits to identify a request end-to-end. The SDK
 * surfaces this on `HttpResponse.requestId` and `AgentChatError.requestId`
 * so support / log-correlation workflows ("paste me the request id") are
 * one field away.
 */
const REQUEST_ID_HEADER = 'x-request-id'

/**
 * Retry policy applied when a call is eligible for auto-retry.
 *
 * `baseDelayMs` is the first sleep duration; each subsequent attempt
 * multiplies by 2 with ±25% jitter, capped at `maxDelayMs`. `maxRetries`
 * is the number of retries AFTER the first attempt — so `maxRetries: 3`
 * means up to 4 total HTTP requests.
 *
 * A `Retry-After` response header always wins over the backoff formula
 * (an honored server hint is more useful than the SDK's guess).
 */
export interface RetryPolicy {
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 250,
  maxDelayMs: 8_000,
}

/**
 * Per-request retry override:
 * - `'auto'` — use the transport's default RetryPolicy.
 * - `'never'` — skip retry even on retriable failures.
 * - `RetryPolicy` object — use this policy just for this call.
 */
export type RetryOption = 'auto' | 'never' | RetryPolicy

export interface RequestInfo {
  method: HttpMethod
  url: string
  attempt: number
  /**
   * The request headers as an object. The `Authorization` header is
   * always redacted (`Bearer ***`) — hooks must never see the raw key.
   */
  headers: Record<string, string>
}

export interface ResponseInfo extends RequestInfo {
  status: number
  durationMs: number
}

export interface ErrorInfo extends RequestInfo {
  status?: number
  durationMs: number
  error: Error
}

export interface RetryInfo extends RequestInfo {
  status?: number
  error?: Error
  delayMs: number
  nextAttempt: number
}

export interface RequestHooks {
  onRequest?: (info: RequestInfo) => void | Promise<void>
  onResponse?: (info: ResponseInfo) => void | Promise<void>
  onError?: (info: ErrorInfo) => void | Promise<void>
  onRetry?: (info: RetryInfo) => void | Promise<void>
}

export interface HttpTransportOptions {
  apiKey?: string
  baseUrl: string
  /** Request timeout in milliseconds. Default: 30_000 (30s). 0 disables the timeout. */
  timeoutMs?: number
  retry?: RetryPolicy
  hooks?: RequestHooks
  /**
   * Optional `fetch` override. Tests use this to stub the network. Defaults
   * to `globalThis.fetch` — which is native on Node 18+, every modern
   * browser, Deno, Bun, and every major edge runtime.
   */
  fetch?: typeof fetch
  /** Extra headers applied to every request (merged before per-call overrides). */
  defaultHeaders?: Record<string, string>
  /**
   * Override the `User-Agent` header. Defaults to
   * `agentchat-ts/<version> <runtime>/<runtime-version>`. Passing `null`
   * omits the header entirely — useful when a fetch polyfill manages
   * its own UA (Cloudflare Workers, for example, prepend their own).
   */
  userAgent?: string | null
}

export interface HttpRequestOptions {
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
  retry?: RetryOption
  /**
   * Idempotency-Key header value. When set, the call becomes retry-eligible
   * even if the HTTP method is not normally idempotent (POST/PATCH).
   */
  idempotencyKey?: string
  timeoutMs?: number
  /**
   * Override the default JSON body handling. When `body` is a `Uint8Array`,
   * `ArrayBuffer`, `Blob`, or `ReadableStream` the transport sends it as-is
   * and preserves the caller's `Content-Type`. Otherwise the body is
   * JSON.stringified and `Content-Type: application/json` is added.
   */
  rawBody?: boolean
  /**
   * Whether the transport follows HTTP 3xx redirects. Defaults to true (the
   * native fetch behavior). Set to `false` when the caller needs to inspect
   * the redirect target directly — for example, to capture a signed-URL
   * Location header on an attachment download without leaking the SDK's
   * `Authorization` header to the redirect target. When false, 3xx
   * responses resolve normally (not treated as errors) and the response
   * body is empty but `response.headers.get('location')` holds the target.
   */
  followRedirect?: boolean
  /**
   * When the caller receives the `HttpResponse` object (via the raw
   * `http.request()` surface), set this so the transport doesn't try to
   * JSON-parse the body. Implicitly true when `followRedirect === false`.
   */
  expectNoBody?: boolean
}

export interface HttpResponse<T> {
  data: T
  headers: Headers
  status: number
  /**
   * The server's `x-request-id` header, if present. Use this when filing
   * support tickets or correlating client-side logs with server-side traces.
   */
  requestId: string | null
}

/**
 * HTTP methods that are safely retryable per RFC 9110 — the server MUST
 * treat them as idempotent. POST and PATCH are excluded; callers opt in
 * by passing `retry: 'auto'` or an explicit `idempotencyKey`.
 */
const IDEMPOTENT_METHODS: ReadonlySet<HttpMethod> = new Set<HttpMethod>([
  'GET',
  'HEAD',
  'PUT',
  'DELETE',
])

/**
 * HTTP status codes that are transient server failures worth retrying.
 * 501/505/511 intentionally excluded — they represent a permanent mismatch
 * (unsupported method, version, or network auth), not a flake.
 */
const RETRIABLE_STATUSES: ReadonlySet<number> = new Set([408, 425, 429, 500, 502, 503, 504])

export class HttpTransport {
  private readonly apiKey?: string
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly retry: RetryPolicy
  private readonly hooks: RequestHooks
  private readonly fetchFn: typeof fetch
  private readonly defaultHeaders: Record<string, string>
  private readonly userAgent: string | null

  constructor(options: HttpTransportOptions) {
    this.apiKey = options.apiKey
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.retry = options.retry ?? DEFAULT_RETRY_POLICY
    this.hooks = options.hooks ?? {}
    this.defaultHeaders = options.defaultHeaders ?? {}
    // Normalize: undefined → default UA, null → omit, string → verbatim.
    this.userAgent =
      options.userAgent === undefined ? defaultUserAgent() : options.userAgent
    const f = options.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch
    if (!f) {
      throw new Error(
        'AgentChat SDK: no `fetch` implementation available. Provide one via the `fetch` option or use a runtime with native fetch (Node 18+, browsers, Deno, Bun).',
      )
    }
    this.fetchFn = f.bind(globalThis)
  }

  async request<T>(
    method: HttpMethod,
    path: string,
    opts: HttpRequestOptions = {},
  ): Promise<HttpResponse<T>> {
    const url = `${this.baseUrl}${path}`
    const policy = resolveRetryPolicy(opts.retry, this.retry)
    const canRetry = isRetryEligible(method, opts.idempotencyKey, opts.retry)
    const maxAttempts = canRetry ? policy.maxRetries + 1 : 1
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs

    let lastError: Error | undefined
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const started = now()
      const { headers, redactedForHooks, body } = this.buildHeadersAndBody(
        method,
        opts,
      )

      const requestInfo: RequestInfo = {
        method,
        url,
        attempt,
        headers: redactedForHooks,
      }
      await safeInvoke(this.hooks.onRequest, requestInfo)

      const controller = new AbortController()
      const cleanup = wireAbortSignal(controller, opts.signal, timeoutMs)

      let res: Response
      try {
        res = await this.fetchFn(url, {
          method,
          headers,
          body,
          signal: controller.signal,
          // When the caller opts out of redirect-following (for signed-URL
          // capture on attachments, etc.), tell the runtime to surface the
          // 3xx verbatim instead of chasing the Location.
          ...(opts.followRedirect === false ? { redirect: 'manual' as const } : {}),
        })
      } catch (err) {
        cleanup()
        const error = toConnectionError(err, opts.signal)
        const durationMs = now() - started
        await safeInvoke(this.hooks.onError, {
          ...requestInfo,
          durationMs,
          error,
        })
        if (attempt < maxAttempts && !isUserAbort(opts.signal)) {
          const delayMs = computeDelay(policy, attempt, null)
          await safeInvoke(this.hooks.onRetry, {
            ...requestInfo,
            error,
            delayMs,
            nextAttempt: attempt + 1,
          })
          await sleep(delayMs, opts.signal)
          lastError = error
          continue
        }
        throw error
      }
      cleanup()

      const durationMs = now() - started

      // `followRedirect: false` makes 3xx a successful terminal state —
      // the caller asked to inspect the redirect instead of chasing it,
      // so surface the response verbatim without JSON-parsing the
      // (typically empty) body.
      const isManualRedirect =
        opts.followRedirect === false && res.status >= 300 && res.status < 400

      if (res.ok || isManualRedirect) {
        await safeInvoke(this.hooks.onResponse, {
          ...requestInfo,
          status: res.status,
          durationMs,
        })
        const data =
          isManualRedirect || opts.expectNoBody
            ? (undefined as T)
            : await parseJsonOrVoid<T>(res)
        return {
          data,
          headers: res.headers,
          status: res.status,
          requestId: res.headers.get(REQUEST_ID_HEADER),
        }
      }

      // Non-2xx path. Decide: retry or surface?
      const retriable =
        canRetry &&
        attempt < maxAttempts &&
        RETRIABLE_STATUSES.has(res.status)

      const errBody = await parseErrorBody(res)
      const error = createAgentChatError(errBody, res.status, res.headers)

      await safeInvoke(this.hooks.onError, {
        ...requestInfo,
        status: res.status,
        durationMs,
        error,
      })

      if (retriable) {
        const retryAfter = parseRetryAfter(res.headers.get('retry-after'))
        const delayMs = computeDelay(policy, attempt, retryAfter)
        await safeInvoke(this.hooks.onRetry, {
          ...requestInfo,
          status: res.status,
          error,
          delayMs,
          nextAttempt: attempt + 1,
        })
        await sleep(delayMs, opts.signal)
        lastError = error
        continue
      }

      throw error
    }

    /* c8 ignore next 4 — unreachable: the loop always either returns or throws. */
    throw (
      lastError ??
      new ConnectionError('AgentChat SDK: request loop exited without a result')
    )
  }

  private buildHeadersAndBody(
    method: HttpMethod,
    opts: HttpRequestOptions,
  ): { headers: Record<string, string>; redactedForHooks: Record<string, string>; body: BodyInit | undefined } {
    const headers: Record<string, string> = {
      ...this.defaultHeaders,
      ...(opts.headers ?? {}),
    }
    if (this.userAgent && !headers['User-Agent'] && !headers['user-agent']) {
      headers['User-Agent'] = this.userAgent
    }
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`
    }
    if (opts.idempotencyKey) {
      headers['Idempotency-Key'] = opts.idempotencyKey
    }

    let body: BodyInit | undefined
    if (opts.body === undefined) {
      body = undefined
    } else if (opts.rawBody) {
      body = opts.body as BodyInit
    } else {
      body = JSON.stringify(opts.body)
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json'
    }

    // Redact for hooks — never surface raw credentials through observability.
    const redactedForHooks: Record<string, string> = { ...headers }
    if (redactedForHooks['Authorization']) {
      redactedForHooks['Authorization'] = 'Bearer ***'
    }

    return { headers, redactedForHooks, body }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function resolveRetryPolicy(opt: RetryOption | undefined, fallback: RetryPolicy): RetryPolicy {
  if (opt && typeof opt === 'object') return opt
  return fallback
}

function isRetryEligible(
  method: HttpMethod,
  idempotencyKey: string | undefined,
  retry: RetryOption | undefined,
): boolean {
  if (retry === 'never') return false
  if (retry === 'auto' || (retry && typeof retry === 'object')) return true
  if (idempotencyKey) return true
  return IDEMPOTENT_METHODS.has(method)
}

function computeDelay(policy: RetryPolicy, attempt: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) {
    return Math.min(retryAfterMs, policy.maxDelayMs)
  }
  const exp = policy.baseDelayMs * Math.pow(2, attempt - 1)
  const capped = Math.min(exp, policy.maxDelayMs)
  const jitter = 1 - 0.25 + Math.random() * 0.5 // ±25%
  return Math.max(0, Math.floor(capped * jitter))
}

function now(): number {
  // Performance-timer when available (monotonic, not wall-clock — insulated
  // against NTP / DST). Falls back to Date.now on runtimes that don't ship
  // `performance` in the global scope.
  const perf = (globalThis as { performance?: { now(): number } }).performance
  return perf ? perf.now() : Date.now()
}

function wireAbortSignal(
  controller: AbortController,
  userSignal: AbortSignal | undefined,
  timeoutMs: number,
): () => void {
  const cleanups: Array<() => void> = []

  if (userSignal) {
    if (userSignal.aborted) {
      controller.abort(userSignal.reason)
    } else {
      const onAbort = () => controller.abort(userSignal.reason)
      userSignal.addEventListener('abort', onAbort, { once: true })
      cleanups.push(() => userSignal.removeEventListener('abort', onAbort))
    }
  }

  if (timeoutMs > 0) {
    const timer = setTimeout(() => {
      controller.abort(new Error(`AgentChat SDK: request timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    cleanups.push(() => clearTimeout(timer))
  }

  return () => {
    for (const fn of cleanups) fn()
  }
}

function isUserAbort(userSignal: AbortSignal | undefined): boolean {
  return Boolean(userSignal?.aborted)
}

function toConnectionError(err: unknown, userSignal: AbortSignal | undefined): Error {
  if (err instanceof AgentChatError) return err
  if (isUserAbort(userSignal)) {
    // A user-driven abort is not a connection failure — bubble a predictable
    // DOMException-like error so `error.name === 'AbortError'` keeps working.
    const abortErr = new Error(
      err instanceof Error ? err.message : 'Request aborted',
    )
    abortErr.name = 'AbortError'
    return abortErr
  }
  const message = err instanceof Error ? err.message : String(err)
  return new ConnectionError(message)
}

async function parseJsonOrVoid<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T
  const text = await res.text()
  if (!text) return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    // The server occasionally returns non-JSON for 2xx (e.g., 302 redirects
    // handled upstream). Surface the raw text so callers can debug instead
    // of getting a silent empty object.
    throw new ConnectionError(
      `AgentChat SDK: expected JSON response but got: ${text.slice(0, 200)}`,
    )
  }
}

async function parseErrorBody(res: Response): Promise<AgentChatErrorResponse> {
  try {
    const text = await res.text()
    if (!text) {
      return { code: statusToCode(res.status), message: res.statusText || 'Request failed' }
    }
    const body = JSON.parse(text)
    if (body && typeof body === 'object' && typeof body.code === 'string' && typeof body.message === 'string') {
      return body as AgentChatErrorResponse
    }
    return {
      code: statusToCode(res.status),
      message: res.statusText || 'Request failed',
      details: { body },
    }
  } catch {
    return { code: statusToCode(res.status), message: res.statusText || 'Request failed' }
  }
}

/**
 * Fallback `code` used only when the server returns an error with no
 * JSON body (rare — load balancer 502s, network appliances, etc.). These
 * values align with the server's `ErrorCode` enum so downstream switches
 * on `err.code` behave consistently whether the body parsed or not.
 */
function statusToCode(status: number): string {
  if (status === 400) return 'VALIDATION_ERROR'
  if (status === 401) return 'UNAUTHORIZED'
  if (status === 403) return 'FORBIDDEN'
  if (status === 404) return 'AGENT_NOT_FOUND'
  if (status === 410) return 'GROUP_DELETED'
  if (status === 429) return 'RATE_LIMITED'
  if (status >= 500) return 'INTERNAL_ERROR'
  return 'INTERNAL_ERROR'
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      const reason = signal?.reason ?? new Error('Aborted')
      reject(reason instanceof Error ? reason : new Error(String(reason)))
    }
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer)
        reject(signal.reason ?? new Error('Aborted'))
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
      }
    }
  })
}

async function safeInvoke<T>(
  hook: ((info: T) => void | Promise<void>) | undefined,
  info: T,
): Promise<void> {
  if (!hook) return
  try {
    await hook(info)
  } catch {
    // Observability hooks must never break requests — swallow silently.
  }
}
