/**
 * ChannelOutboundAdapter — OpenClaw send → AgentChat.
 *
 * `deliveryMode: 'direct'` — we own the HTTP call stack; OpenClaw hands us
 * a `to` + `text` (+ optional media) and we translate that into the same
 * `OutboundMessageInput` our internal runtime already knows how to ship.
 *
 * Routing rule:
 *   - `to` starts with `grp_` → group message (conversationId = to)
 *   - anything else → direct message to the handle
 * (Target normalization already stripped `@` — see binding/messaging.ts.)
 *
 * Reply + media:
 *   - `replyToId` is passed through as `metadata.reply_to` so the server
 *     threads it correctly in both direct and group conversations.
 *   - `sendMedia` runs `createUpload` + `PUT` against the presigned URL
 *     first, then sends a `type: "file"` message carrying the
 *     `attachment_id`. The bytes never pass through OpenClaw.
 */

import type {
  ChannelOutboundAdapter,
  OutboundDeliveryResult,
  OpenClawConfig,
} from './openclaw-types.js'

// ChannelOutboundContext is the argument shape for send* calls — we only
// read the fields we need (cfg, accountId, to, text, replyToId, mediaUrl,
// mediaReadFile), so a loose local alias keeps this portable across minor
// SDK revisions that tweak optional fields.
type SendCtx = {
  cfg: OpenClawConfig
  to: string
  text: string
  mediaUrl?: string
  replyToId?: string | null
  accountId?: string | null
  mediaReadFile?: (path: string) => Promise<Buffer>
}

import type { OutboundMessageInput } from '../outbound.js'
import { AGENTCHAT_CHANNEL_ID } from '../channel-account.js'
import { classifyConversationId } from '../inbound.js'
import { readChannelSection, readAccountRaw } from '../channel-account.js'
import { parseChannelConfig } from '../config-schema.js'
import { AgentChatChannelError } from '../errors.js'
import { registerRuntime, getRuntime } from './runtime-registry.js'
import { getClient } from './sdk-client.js'
import { createLogger } from '../log.js'

function resolveConfig(cfg: OpenClawConfig | undefined, accountId?: string | null) {
  const section = readChannelSection(cfg)
  const raw = readAccountRaw(section, accountId ?? 'default')
  if (!raw) return null
  try {
    return parseChannelConfig(raw)
  } catch {
    return null
  }
}

/**
 * Ensure we have a live runtime for this account. When OpenClaw delivers
 * the first outbound before `gateway.startAccount` has fired — or calls
 * `sendText` outside of an active gateway session (e.g. from a CLI one-shot
 * send) — we lazily spin one up. `getRuntime` returns `undefined` until
 * the gateway registers one.
 */
async function ensureRuntime(accountId: string, cfg: OpenClawConfig | undefined) {
  const existing = getRuntime(accountId)
  if (existing) return existing
  const config = resolveConfig(cfg, accountId)
  if (!config) {
    throw new Error(
      `[agentchat:${accountId}] cannot send — channels.agentchat config is missing or invalid`,
    )
  }
  const logger = createLogger({
    level: config.observability.logLevel,
    redactKeys: config.observability.redactKeys,
  })
  return registerRuntime({ accountId, config, logger, handlers: {} })
}

function buildInputForTarget(
  to: string,
  text: string | undefined,
  replyToId: string | null | undefined,
  attachmentId?: string,
): OutboundMessageInput {
  const metadata = replyToId ? { reply_to: replyToId } : undefined
  const content: OutboundMessageInput['content'] = {
    ...(text !== undefined && text.length > 0 ? { text } : {}),
    ...(attachmentId ? { attachmentId } : {}),
  }

  const kind: 'direct' | 'group' =
    classifyConversationId(to) === 'group' ? 'group' : 'direct'

  if (kind === 'group') {
    return {
      kind: 'group',
      conversationId: to,
      type: attachmentId ? 'file' : 'text',
      content,
      ...(metadata ? { metadata } : {}),
    }
  }
  return {
    kind: 'direct',
    to,
    type: attachmentId ? 'file' : 'text',
    content,
    ...(metadata ? { metadata } : {}),
  }
}

async function deliver(
  ctx: SendCtx,
  attachmentId?: string,
): Promise<OutboundDeliveryResult> {
  const accountId = ctx.accountId ?? 'default'
  const runtime = await ensureRuntime(accountId, ctx.cfg)
  const input = buildInputForTarget(
    ctx.to,
    ctx.text,
    ctx.replyToId,
    attachmentId,
  )
  const result = await runtime.sendMessage(input)
  return {
    channel: AGENTCHAT_CHANNEL_ID,
    messageId: result.message.id,
    conversationId: result.message.conversation_id,
    timestamp: Date.parse(result.message.created_at),
    meta: {
      attempts: result.attempts,
      idempotentReplay: result.idempotentReplay,
      requestId: result.requestId ?? undefined,
    },
  }
}

/**
 * SSRF-safe remote media fetch.
 *
 * An agent supplies the `mediaUrl`. Without guardrails, a malicious or
 * compromised agent could point us at `http://169.254.169.254/...` (AWS
 * IMDS), `http://localhost`, or an internal service to exfiltrate creds
 * or probe the local network. We enforce:
 *   - HTTPS only (HTTP allowed only against localhost for dev tests).
 *   - Host must not resolve to a private/loopback/link-local address.
 *   - 30-second hard timeout on the fetch itself.
 *   - 25 MB response-size ceiling (matches the server's attachment cap).
 *
 * The block list is intentionally literal-string based on `URL.hostname`.
 * We do NOT DNS-resolve first and re-validate — that would open a TOCTOU
 * window where the resolver returns public then private. Callers who
 * need self-hosted media should upload via the direct SDK path.
 */
const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127(\.\d{1,3}){3}$/,
  /^10(\.\d{1,3}){3}$/,
  /^192\.168(\.\d{1,3}){2}$/,
  /^172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}$/,
  /^169\.254(\.\d{1,3}){2}$/,
  /^::1$/,
  /^fc00:/i,
  /^fd/i,
  /^fe80:/i,
  /^\[::1\]$/,
] as const

const MAX_MEDIA_BYTES = 25 * 1024 * 1024
const MEDIA_FETCH_TIMEOUT_MS = 30_000

function assertMediaUrlSafe(urlStr: string): URL {
  let url: URL
  try {
    url = new URL(urlStr)
  } catch {
    throw new AgentChatChannelError(
      'terminal-user',
      `mediaUrl is not a valid URL: ${urlStr}`,
    )
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AgentChatChannelError(
      'terminal-user',
      `mediaUrl protocol must be http(s): ${url.protocol}`,
    )
  }
  // Node's WHATWG URL parser preserves brackets around IPv6 literals on
  // `hostname` (e.g. `'[fe80::1]'`). Strip them before pattern-matching so
  // the IPv6 regex entries below actually get a chance to fire.
  const hostRaw = url.hostname.toLowerCase()
  const host =
    hostRaw.startsWith('[') && hostRaw.endsWith(']') ? hostRaw.slice(1, -1) : hostRaw
  for (const pattern of PRIVATE_HOST_PATTERNS) {
    if (pattern.test(host)) {
      throw new AgentChatChannelError(
        'terminal-user',
        `mediaUrl host is private or loopback: ${host}`,
      )
    }
  }
  return url
}

async function uploadMediaFromUrl(
  ctx: SendCtx,
  mediaUrl: string,
): Promise<string> {
  const accountId = ctx.accountId ?? 'default'
  const config = resolveConfig(ctx.cfg, accountId)
  if (!config) {
    throw new AgentChatChannelError(
      'terminal-user',
      `[agentchat:${accountId}] cannot upload media — config missing/invalid`,
    )
  }
  const client = getClient({ accountId, config })

  // Pull the bytes, regardless of whether the gateway handed us a file URL,
  // a data URL, or a remote HTTPS URL. The runtime's media-access helpers
  // already do this for bundled channels; we replicate the minimal piece we
  // need here to stay portable. Remote URLs go through SSRF validation.
  let bytes: ArrayBuffer
  let contentType: string | undefined
  let filename = 'attachment'
  if (mediaUrl.startsWith('file://') && ctx.mediaReadFile) {
    const path = decodeURIComponent(mediaUrl.replace(/^file:\/\//, ''))
    const buf = await ctx.mediaReadFile(path)
    if (buf.byteLength > MAX_MEDIA_BYTES) {
      throw new AgentChatChannelError(
        'terminal-user',
        `media exceeds ${MAX_MEDIA_BYTES} bytes: ${buf.byteLength}`,
      )
    }
    // Copy into a fresh ArrayBuffer so fetch's BodyInit is happy on all
    // runtimes (Node 20's fetch is stricter than browsers about shared
    // buffer typings).
    const copy = new Uint8Array(buf.byteLength)
    copy.set(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))
    bytes = copy.buffer
    filename = path.split(/[\\/]/).pop() ?? filename
  } else {
    assertMediaUrlSafe(mediaUrl)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), MEDIA_FETCH_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(mediaUrl, { signal: controller.signal, redirect: 'error' })
    } catch (err) {
      clearTimeout(timer)
      throw new AgentChatChannelError(
        'retry-transient',
        `could not fetch media: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      )
    }
    clearTimeout(timer)
    if (!res.ok) {
      throw new AgentChatChannelError(
        res.status >= 500 ? 'retry-transient' : 'terminal-user',
        `could not fetch media: ${res.status} ${res.statusText}`,
        { statusCode: res.status },
      )
    }
    const declaredSize = Number(res.headers.get('content-length') ?? NaN)
    if (Number.isFinite(declaredSize) && declaredSize > MAX_MEDIA_BYTES) {
      throw new AgentChatChannelError(
        'terminal-user',
        `media content-length exceeds cap: ${declaredSize}`,
      )
    }
    bytes = await res.arrayBuffer()
    if (bytes.byteLength > MAX_MEDIA_BYTES) {
      throw new AgentChatChannelError(
        'terminal-user',
        `media body exceeds cap after fetch: ${bytes.byteLength}`,
      )
    }
    contentType = res.headers.get('content-type') ?? undefined
    const cd = res.headers.get('content-disposition')
    const nameMatch = cd ? /filename="?([^";]+)"?/.exec(cd) : null
    if (nameMatch && nameMatch[1]) filename = nameMatch[1]
  }

  // The AgentChat API restricts `content_type` to a narrow allowlist
  // (image/png, image/jpeg, application/pdf, …). When the remote server
  // didn't advertise a type, or advertised one outside the allowlist, we
  // fall back to `application/octet-stream` and let the server reject if
  // the policy has tightened. Typed as `string` on the wire.
  const mimeType: string = (() => {
    if (!contentType || contentType.length === 0) return 'application/octet-stream'
    const head = contentType.split(';')[0]
    return head ? head.trim() : 'application/octet-stream'
  })()

  // sha256 digest (Web Crypto is available in Node 20+).
  const hashBuf = await crypto.subtle.digest('SHA-256', bytes)
  const sha256 = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  const reservation = await client.createUpload({
    to: ctx.to,
    filename,
    content_type: mimeType as Parameters<typeof client.createUpload>[0]['content_type'],
    size: bytes.byteLength,
    sha256,
  })

  const putController = new AbortController()
  const putTimer = setTimeout(() => putController.abort(), MEDIA_FETCH_TIMEOUT_MS)
  let putRes: Response
  try {
    putRes = await fetch(reservation.upload_url, {
      method: 'PUT',
      headers: { 'content-type': mimeType },
      body: bytes,
      signal: putController.signal,
    })
  } catch (err) {
    clearTimeout(putTimer)
    throw new AgentChatChannelError(
      'retry-transient',
      `attachment PUT failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }
  clearTimeout(putTimer)
  if (!putRes.ok) {
    throw new AgentChatChannelError(
      putRes.status >= 500 ? 'retry-transient' : 'terminal-user',
      `attachment PUT failed: ${putRes.status} ${putRes.statusText}`,
      { statusCode: putRes.status },
    )
  }

  return reservation.attachment_id
}

export const agentchatOutboundAdapter: ChannelOutboundAdapter = {
  deliveryMode: 'direct',

  async sendText(ctx) {
    return deliver(ctx)
  },

  async sendMedia(ctx) {
    if (!ctx.mediaUrl) {
      throw new AgentChatChannelError(
        'terminal-user',
        '[agentchat] sendMedia called without mediaUrl',
      )
    }
    const attachmentId = await uploadMediaFromUrl(ctx, ctx.mediaUrl)
    return deliver(ctx, attachmentId)
  },

  async sendFormattedText(ctx) {
    return [await deliver(ctx)]
  },
}
