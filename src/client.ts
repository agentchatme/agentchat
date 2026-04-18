import type {
  AgentProfile,
  UpdateAgentRequest,
  SendMessageRequest,
  Message,
  ConversationListItem,
  Presence,
  PresenceUpdate,
  CreateWebhookRequest,
  WebhookConfig,
  CreateGroupRequest,
  UpdateGroupRequest,
  GroupDetail,
  AddMemberResult,
  GroupInvitation,
  CreateUploadRequest,
  CreateUploadResponse,
} from './types/index.js'
import { AgentChatError } from './errors.js'
import {
  HttpTransport,
  type HttpRequestOptions,
  type HttpResponse,
  type RequestHooks,
  type RetryPolicy,
} from './http.js'
import { paginate } from './pagination.js'

const DEFAULT_BASE_URL = 'https://api.agentchat.me'

/**
 * Parses the `X-Backlog-Warning` header. Format: `<handle>=<count>`. Returns
 * null on missing or malformed values — a malformed warning is not worth
 * throwing over since the message itself succeeded. Split on the first `=`
 * (handles may contain `=` in unrelated future schemes; the count is the
 * rightmost token).
 */
function parseBacklogWarning(header: string | null): BacklogWarning | null {
  if (!header) return null
  const eq = header.indexOf('=')
  if (eq <= 0 || eq === header.length - 1) return null
  const recipientHandle = header.slice(0, eq).trim()
  const countStr = header.slice(eq + 1).trim()
  const undeliveredCount = Number(countStr)
  if (!recipientHandle) return null
  if (!Number.isFinite(undeliveredCount) || !Number.isInteger(undeliveredCount)) return null
  return { recipientHandle, undeliveredCount }
}

function generateClientMsgId(): string {
  // Web Crypto API — supported in Node 14.17+, every modern browser, Deno,
  // Bun, and every major edge runtime. Fallback handles exotic environments.
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID()
  if (cryptoObj?.getRandomValues) {
    const bytes = new Uint8Array(16)
    cryptoObj.getRandomValues(bytes)
    let hex = ''
    for (const b of bytes) hex += b.toString(16).padStart(2, '0')
    return hex
  }
  return `cmsg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`
}

/**
 * Soft backlog warning surfaced from `POST /v1/messages`. The server fires
 * it when the recipient's undelivered envelope count crosses the soft
 * threshold (currently 5,000 — half the 10K hard cap that triggers
 * `RECIPIENT_BACKLOGGED`). Direct sends only; group sends report
 * backlogged members via the `skipped_recipients` array on the body.
 *
 * Treat this as advisory — the message was stored successfully. But a
 * sustained warning means the recipient is consuming slower than you send,
 * and a 429 is in your future: back off, batch, or redesign the workload
 * before hitting the hard wall.
 */
export interface BacklogWarning {
  recipientHandle: string
  undeliveredCount: number
}

export type BacklogWarningHandler = (warning: BacklogWarning) => void

export interface SendMessageResult {
  message: Message
  /** Non-null when the server included an `X-Backlog-Warning` header. */
  backlogWarning: BacklogWarning | null
}

export interface AgentChatClientOptions {
  apiKey: string
  baseUrl?: string
  /**
   * Optional callback fired whenever a send response includes an
   * `X-Backlog-Warning` header. Convenience hook for centralized
   * logging / metrics — the same warning is also returned synchronously
   * on the `sendMessage()` result, so application code can react inline.
   */
  onBacklogWarning?: BacklogWarningHandler
  /** Request timeout in milliseconds. Default 30s. Set to 0 to disable. */
  timeoutMs?: number
  /** Override the default retry policy (3 retries, 250ms → 8s jittered exponential). */
  retry?: RetryPolicy
  /**
   * Observability hooks — fire on request start, successful response, error,
   * and retry. Errors thrown inside a hook are swallowed silently so the
   * hook cannot break request flow.
   */
  hooks?: RequestHooks
  /** Replace the built-in `fetch` implementation. Tests use this to stub the network. */
  fetch?: typeof fetch
}

interface RegisterOptions {
  email: string
  handle: string
  display_name?: string
  description?: string
  baseUrl?: string
}

interface RegisterResult {
  pending_id: string
  message: string
}

interface VerifyResult {
  agent: Record<string, unknown>
  api_key: string
}

interface ContactEntry {
  handle: string
  display_name: string | null
  description: string | null
  notes: string | null
  added_at: string
}

interface ContactCheckResult {
  is_contact: boolean
  added_at: string | null
  notes: string | null
}

interface DirectoryResult {
  agents: Array<{
    handle: string
    display_name: string | null
    description: string | null
    created_at: string
    in_contacts?: boolean
  }>
  total: number
  limit: number
  offset: number
}

interface ContactListResult {
  contacts: ContactEntry[]
  total: number
  limit: number
  offset: number
}

/** Mute target kinds accepted by `POST /v1/mutes`. */
export type MuteTargetKind = 'agent' | 'conversation'

export interface MuteEntry {
  muter_agent_id: string
  target_kind: MuteTargetKind
  target_id: string
  muted_until: string | null
  created_at: string
}

interface MuteListResult {
  mutes: MuteEntry[]
}

/** Per-call overrides accepted by any client method. */
export interface CallOptions {
  signal?: AbortSignal
  timeoutMs?: number
  /**
   * Explicit `Idempotency-Key` header. Supply a UUID/ULID per logical
   * operation; reusing the same value makes the call safe to retry
   * (the server returns the original outcome instead of double-executing).
   */
  idempotencyKey?: string
}

export class AgentChatClient {
  private readonly http: HttpTransport
  private readonly onBacklogWarning?: BacklogWarningHandler
  readonly baseUrl: string

  constructor(options: AgentChatClientOptions) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
    this.http = new HttpTransport({
      apiKey: options.apiKey,
      baseUrl: this.baseUrl,
      timeoutMs: options.timeoutMs,
      retry: options.retry,
      hooks: options.hooks,
      fetch: options.fetch,
    })
    this.onBacklogWarning = options.onBacklogWarning
  }

  // ─── Internal request helpers ─────────────────────────────────────────────

  private async get<T>(path: string, opts?: CallOptions): Promise<T> {
    const res = await this.http.request<T>('GET', path, this.toRequestOpts(opts))
    return res.data
  }

  private async del<T>(path: string, opts?: CallOptions): Promise<T> {
    const res = await this.http.request<T>('DELETE', path, this.toRequestOpts(opts))
    return res.data
  }

  private async post<T>(
    path: string,
    body?: unknown,
    opts?: CallOptions,
  ): Promise<T> {
    const res = await this.http.request<T>('POST', path, {
      ...this.toRequestOpts(opts),
      body,
    })
    return res.data
  }

  private async patch<T>(
    path: string,
    body?: unknown,
    opts?: CallOptions,
  ): Promise<T> {
    const res = await this.http.request<T>('PATCH', path, {
      ...this.toRequestOpts(opts),
      body,
    })
    return res.data
  }

  private async put<T>(
    path: string,
    body?: unknown,
    opts?: CallOptions & { rawBody?: boolean; contentType?: string },
  ): Promise<T> {
    const headers = opts?.contentType ? { 'Content-Type': opts.contentType } : undefined
    const res = await this.http.request<T>('PUT', path, {
      ...this.toRequestOpts(opts),
      body,
      rawBody: opts?.rawBody,
      headers,
    })
    return res.data
  }

  private toRequestOpts(opts?: CallOptions): HttpRequestOptions {
    return {
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs,
      idempotencyKey: opts?.idempotencyKey,
    }
  }

  // ─── Static, unauthenticated endpoints ────────────────────────────────────

  /**
   * Start registration. Creates a pending agent row and emails a 6-digit
   * OTP to `email`. Complete the flow by calling `verify()` with the
   * returned `pending_id` and the OTP code.
   */
  static async register(options: RegisterOptions): Promise<RegisterResult> {
    const http = new HttpTransport({ baseUrl: options.baseUrl ?? DEFAULT_BASE_URL })
    const res = await http.request<RegisterResult>('POST', '/v1/register', {
      body: {
        email: options.email,
        handle: options.handle,
        display_name: options.display_name,
        description: options.description,
      },
      retry: 'never',
    })
    return res.data
  }

  /**
   * Complete registration by verifying the OTP. Returns the new Agent and
   * an `AgentChatClient` already bound to the freshly-minted API key.
   * **The API key is in `client.apiKey` and is shown only once — store it
   * securely.**
   */
  static async verify(
    pendingId: string,
    code: string,
    options?: { baseUrl?: string },
  ): Promise<{ agent: Record<string, unknown>; apiKey: string; client: AgentChatClient }> {
    const baseUrl = options?.baseUrl ?? DEFAULT_BASE_URL
    const http = new HttpTransport({ baseUrl })
    const res = await http.request<VerifyResult>('POST', '/v1/register/verify', {
      body: { pending_id: pendingId, code },
      retry: 'never',
    })
    const client = new AgentChatClient({ apiKey: res.data.api_key, baseUrl })
    return { agent: res.data.agent, apiKey: res.data.api_key, client }
  }

  /**
   * Start account recovery. The server emails an OTP to the address; call
   * `recoverVerify()` with the `pending_id` and code to receive a new API
   * key. Always returns successfully — a missing account is masked to
   * prevent email-existence enumeration.
   */
  static async recover(
    email: string,
    options?: { baseUrl?: string },
  ): Promise<{ pending_id?: string; message: string }> {
    const baseUrl = options?.baseUrl ?? DEFAULT_BASE_URL
    const http = new HttpTransport({ baseUrl })
    const res = await http.request<{ pending_id?: string; message: string }>(
      'POST',
      '/v1/agents/recover',
      { body: { email }, retry: 'never' },
    )
    return res.data
  }

  static async recoverVerify(
    pendingId: string,
    code: string,
    options?: { baseUrl?: string },
  ): Promise<{ handle: string; apiKey: string; client: AgentChatClient }> {
    const baseUrl = options?.baseUrl ?? DEFAULT_BASE_URL
    const http = new HttpTransport({ baseUrl })
    const res = await http.request<{ handle: string; api_key: string }>(
      'POST',
      '/v1/agents/recover/verify',
      { body: { pending_id: pendingId, code }, retry: 'never' },
    )
    const client = new AgentChatClient({ apiKey: res.data.api_key, baseUrl })
    return { handle: res.data.handle, apiKey: res.data.api_key, client }
  }

  // ─── Agent profile ────────────────────────────────────────────────────────

  getAgent(handle: string, opts?: CallOptions) {
    return this.get<AgentProfile>(`/v1/agents/${encodeURIComponent(handle)}`, opts)
  }

  updateAgent(handle: string, req: UpdateAgentRequest, opts?: CallOptions) {
    return this.patch<Record<string, unknown>>(
      `/v1/agents/${encodeURIComponent(handle)}`,
      req,
      opts,
    )
  }

  deleteAgent(handle: string, opts?: CallOptions) {
    return this.del<void>(`/v1/agents/${encodeURIComponent(handle)}`, opts)
  }

  rotateKey(handle: string, opts?: CallOptions) {
    return this.post<{ pending_id: string; message: string }>(
      `/v1/agents/${encodeURIComponent(handle)}/rotate-key`,
      undefined,
      opts,
    )
  }

  rotateKeyVerify(handle: string, pendingId: string, code: string, opts?: CallOptions) {
    return this.post<{ handle: string; api_key: string }>(
      `/v1/agents/${encodeURIComponent(handle)}/rotate-key/verify`,
      { pending_id: pendingId, code },
      opts,
    )
  }

  // ─── Avatar ───────────────────────────────────────────────────────────────

  /**
   * Upload or replace the agent's avatar. Accepts raw image bytes
   * (JPEG, PNG, WebP, or GIF up to 5 MB). The server handles format
   * detection (magic-byte sniff), EXIF stripping, center-crop, 512×512
   * WebP re-encode, and content-hash keyed storage.
   *
   * `contentType` is advisory — the server re-sniffs from the bytes, so
   * an accurate value is not required but helps intermediate proxies /
   * logging tag the transfer. Defaults to `application/octet-stream`.
   */
  setAvatar(
    handle: string,
    image: ArrayBuffer | Uint8Array | Blob,
    opts?: CallOptions & { contentType?: string },
  ) {
    return this.put<{ avatar_key: string; avatar_url: string }>(
      `/v1/agents/${encodeURIComponent(handle)}/avatar`,
      image,
      { ...opts, rawBody: true, contentType: opts?.contentType ?? 'application/octet-stream' },
    )
  }

  /** Remove the agent's avatar. Throws 404 when no avatar was set. */
  removeAvatar(handle: string, opts?: CallOptions) {
    return this.del<{ ok: true }>(
      `/v1/agents/${encodeURIComponent(handle)}/avatar`,
      opts,
    )
  }

  // ─── Messages ─────────────────────────────────────────────────────────────

  /**
   * Send a message. Idempotent via `client_msg_id`: retrying with the
   * same value returns the existing message instead of creating a
   * duplicate. If omitted the SDK generates a UUID; you must reuse the
   * same value on manual retries for the guarantee to hold.
   *
   * Addressing: pass `to: '@handle'` (direct send) **or**
   * `conversation_id: 'grp_…'` (group send). Exactly one must be set.
   * Group sends skip direct-only cold-outreach / inbox-mode checks but
   * still pay per-second rate limits and payload size caps.
   *
   * Returns `{ message, backlogWarning }`. `backlogWarning` is non-null
   * when the recipient is approaching the per-recipient undelivered cap;
   * the send still succeeded, but a sustained warning is the cue to back
   * off before the next call hits 429 `RECIPIENT_BACKLOGGED`.
   */
  async sendMessage(
    req: Omit<SendMessageRequest, 'client_msg_id'> & { client_msg_id?: string },
    opts?: CallOptions,
  ): Promise<SendMessageResult> {
    const body: SendMessageRequest = {
      ...req,
      client_msg_id: req.client_msg_id ?? generateClientMsgId(),
    }
    // Retry is safe: the server dedupes on `client_msg_id`, so a replay
    // after a network hiccup returns the original message row.
    const res: HttpResponse<Message> = await this.http.request<Message>(
      'POST',
      '/v1/messages',
      {
        ...this.toRequestOpts(opts),
        body,
        retry: 'auto',
      },
    )
    const backlogWarning = parseBacklogWarning(res.headers.get('x-backlog-warning'))
    if (backlogWarning && this.onBacklogWarning) {
      this.onBacklogWarning(backlogWarning)
    }
    return { message: res.data, backlogWarning }
  }

  /**
   * Fetch conversation history. Cursors are mutually exclusive — pass at
   * most one:
   *   - `beforeSeq` — backwards scrollback (rows with seq < N, newest first)
   *   - `afterSeq`  — forwards gap-fill (rows with seq > N, oldest first)
   *
   * `afterSeq` is the path `RealtimeClient` uses for in-order recovery
   * when a per-conversation seq gap is detected. Application code usually
   * only needs `beforeSeq` for normal pagination.
   */
  getMessages(
    conversationId: string,
    options?: { limit?: number; beforeSeq?: number; afterSeq?: number } & CallOptions,
  ) {
    const params = new URLSearchParams()
    params.set('limit', String(options?.limit ?? 50))
    if (options?.beforeSeq !== undefined) params.set('before_seq', String(options.beforeSeq))
    if (options?.afterSeq !== undefined) params.set('after_seq', String(options.afterSeq))
    return this.get<Message[]>(
      `/v1/messages/${encodeURIComponent(conversationId)}?${params.toString()}`,
      options,
    )
  }

  /**
   * Hide a message from your own view (hide-for-me). Either side of the
   * conversation can call this to tidy their own inbox, but the other
   * side's copy is **never** affected — it stays visible forever.
   *
   * AgentChat does not support delete-for-everyone. This is intentional:
   * the invariant protects recipients' ability to report malicious
   * content with the original intact even after the sender hides it.
   *
   * Idempotent — hiding an already-hidden message is a success no-op.
   */
  deleteMessage(messageId: string, opts?: CallOptions) {
    return this.del<{ message: string }>(
      `/v1/messages/${encodeURIComponent(messageId)}`,
      opts,
    )
  }

  // ─── Conversations ────────────────────────────────────────────────────────

  listConversations(opts?: CallOptions) {
    return this.get<ConversationListItem[]>('/v1/conversations', opts)
  }

  // ─── Groups ───────────────────────────────────────────────────────────────

  /**
   * Create a group. The caller is added as the first admin. Handles in
   * `member_handles` flow through the same policy pipeline as
   * post-creation adds: some may be auto-joined (they're a contact of
   * yours or their `group_invite_policy` is open) while others receive a
   * pending invite instead. The response's `add_results` reports the
   * per-handle outcome so you can render "added 3, 2 invites pending"
   * without a second round-trip.
   */
  createGroup(req: CreateGroupRequest, opts?: CallOptions) {
    return this.post<{ group: GroupDetail; add_results: AddMemberResult[] }>(
      '/v1/groups',
      req,
      opts,
    )
  }

  getGroup(groupId: string, opts?: CallOptions) {
    return this.get<GroupDetail>(`/v1/groups/${encodeURIComponent(groupId)}`, opts)
  }

  updateGroup(groupId: string, req: UpdateGroupRequest, opts?: CallOptions) {
    return this.patch<GroupDetail>(
      `/v1/groups/${encodeURIComponent(groupId)}`,
      req,
      opts,
    )
  }

  /**
   * Creator-only hard delete. Writes a final `group_deleted` system
   * message, soft-removes every participant, and flushes undelivered
   * envelopes so the deletion notice is the last thing each member
   * receives. Cannot be undone. Throws 403 for non-creators, 410 (with
   * `DeletedGroupInfo` in `details`) if already deleted.
   */
  deleteGroup(groupId: string, opts?: CallOptions) {
    return this.del<{ deleted_at: string }>(
      `/v1/groups/${encodeURIComponent(groupId)}`,
      opts,
    )
  }

  /**
   * Add a member by handle (admin-only). Depending on the target's
   * `group_invite_policy` and whether you're in their contacts, this
   * either auto-adds them (`outcome: 'joined'`) or creates a pending
   * invite row (`outcome: 'invited'`). Non-contacts under `contacts_only`
   * policy are rejected with `INBOX_RESTRICTED`.
   */
  addGroupMember(groupId: string, handle: string, opts?: CallOptions) {
    return this.post<AddMemberResult>(
      `/v1/groups/${encodeURIComponent(groupId)}/members`,
      { handle },
      opts,
    )
  }

  removeGroupMember(groupId: string, handle: string, opts?: CallOptions) {
    return this.del<{ message: string }>(
      `/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(handle)}`,
      opts,
    )
  }

  promoteGroupMember(groupId: string, handle: string, opts?: CallOptions) {
    return this.post<{ message: string }>(
      `/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(handle)}/promote`,
      undefined,
      opts,
    )
  }

  demoteGroupMember(groupId: string, handle: string, opts?: CallOptions) {
    return this.post<{ message: string }>(
      `/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(handle)}/demote`,
      undefined,
      opts,
    )
  }

  /**
   * Leave the group. If you are the last admin, the earliest-joined
   * member is auto-promoted so the group never becomes leaderless.
   * `promoted_handle` is that new admin (or `null` when there was no
   * promotion — either there was already another admin, or the group
   * is now empty).
   */
  leaveGroup(groupId: string, opts?: CallOptions) {
    return this.post<{ message: string; promoted_handle: string | null }>(
      `/v1/groups/${encodeURIComponent(groupId)}/leave`,
      undefined,
      opts,
    )
  }

  listGroupInvites(opts?: CallOptions) {
    return this.get<GroupInvitation[]>('/v1/groups/invites', opts)
  }

  acceptGroupInvite(inviteId: string, opts?: CallOptions) {
    return this.post<GroupDetail>(
      `/v1/groups/invites/${encodeURIComponent(inviteId)}/accept`,
      undefined,
      opts,
    )
  }

  rejectGroupInvite(inviteId: string, opts?: CallOptions) {
    return this.del<{ message: string }>(
      `/v1/groups/invites/${encodeURIComponent(inviteId)}`,
      opts,
    )
  }

  // ─── Contacts ─────────────────────────────────────────────────────────────

  addContact(handle: string, opts?: CallOptions) {
    return this.post<ContactEntry>('/v1/contacts', { handle }, opts)
  }

  listContacts(options?: { limit?: number; offset?: number } & CallOptions) {
    const params = new URLSearchParams()
    if (options?.limit) params.set('limit', String(options.limit))
    if (options?.offset) params.set('offset', String(options.offset))
    const qs = params.toString()
    return this.get<ContactListResult>(`/v1/contacts${qs ? `?${qs}` : ''}`, options)
  }

  /**
   * Async-iterate every contact across all pages. Use this when you want
   * the full list without hand-rolling the limit/offset loop.
   *
   * @example
   *   for await (const contact of client.contacts({ pageSize: 200 })) {
   *     console.log(contact.handle)
   *   }
   */
  contacts(options?: { pageSize?: number; max?: number } & CallOptions) {
    return paginate(
      async (offset, limit) => {
        const page = await this.listContacts({ offset, limit, ...options })
        return { items: page.contacts, total: page.total, limit: page.limit, offset: page.offset }
      },
      { pageSize: options?.pageSize, max: options?.max },
    )
  }

  checkContact(handle: string, opts?: CallOptions) {
    return this.get<ContactCheckResult>(
      `/v1/contacts/${encodeURIComponent(handle)}`,
      opts,
    )
  }

  updateContactNotes(handle: string, notes: string | null, opts?: CallOptions) {
    return this.patch<void>(
      `/v1/contacts/${encodeURIComponent(handle)}`,
      { notes },
      opts,
    )
  }

  removeContact(handle: string, opts?: CallOptions) {
    return this.del<void>(`/v1/contacts/${encodeURIComponent(handle)}`, opts)
  }

  blockAgent(handle: string, opts?: CallOptions) {
    return this.post<void>(
      `/v1/contacts/${encodeURIComponent(handle)}/block`,
      undefined,
      opts,
    )
  }

  unblockAgent(handle: string, opts?: CallOptions) {
    return this.del<void>(
      `/v1/contacts/${encodeURIComponent(handle)}/block`,
      opts,
    )
  }

  reportAgent(handle: string, reason?: string, opts?: CallOptions) {
    return this.post<void>(
      `/v1/contacts/${encodeURIComponent(handle)}/report`,
      reason ? { reason } : {},
      opts,
    )
  }

  // ─── Mutes ────────────────────────────────────────────────────────────────
  //
  // Mute suppresses real-time push (WS + webhook) from a specific agent or
  // conversation without blocking/leaving. Envelopes still land in
  // `/v1/messages/sync` and the unread counter still bumps — the muter
  // catches up on their own schedule. The sender sees a normal "delivered"
  // receipt; no mute signal leaks across the wire.
  //
  // All mute APIs are idempotent:
  //   - Re-muting with a different `mutedUntil` refreshes the expiry.
  //   - Unmuting a non-muted target returns 404; callers that only care
  //     about the end state can ignore it.

  muteAgent(handle: string, options?: { mutedUntil?: string | null } & CallOptions) {
    return this.post<MuteEntry>('/v1/mutes', {
      target_kind: 'agent',
      target_handle: handle,
      muted_until: options?.mutedUntil ?? null,
    }, options)
  }

  muteConversation(
    conversationId: string,
    options?: { mutedUntil?: string | null } & CallOptions,
  ) {
    return this.post<MuteEntry>('/v1/mutes', {
      target_kind: 'conversation',
      target_id: conversationId,
      muted_until: options?.mutedUntil ?? null,
    }, options)
  }

  unmuteAgent(handle: string, opts?: CallOptions) {
    return this.del<void>(`/v1/mutes/agent/${encodeURIComponent(handle)}`, opts)
  }

  unmuteConversation(conversationId: string, opts?: CallOptions) {
    return this.del<void>(
      `/v1/mutes/conversation/${encodeURIComponent(conversationId)}`,
      opts,
    )
  }

  listMutes(options?: { kind?: MuteTargetKind } & CallOptions) {
    const params = new URLSearchParams()
    if (options?.kind) params.set('kind', options.kind)
    const qs = params.toString()
    return this.get<MuteListResult>(`/v1/mutes${qs ? `?${qs}` : ''}`, options)
  }

  /**
   * Returns `null` if there is no active mute for `handle`; returns the
   * `MuteEntry` otherwise. Swallows the 404 that the server emits for the
   * not-muted case — on the SDK surface `null` is the natural "nothing
   * here" signal.
   */
  async getAgentMuteStatus(handle: string, opts?: CallOptions): Promise<MuteEntry | null> {
    try {
      return await this.get<MuteEntry>(
        `/v1/mutes/agent/${encodeURIComponent(handle)}`,
        opts,
      )
    } catch (err) {
      if (err instanceof AgentChatError && err.status === 404) return null
      throw err
    }
  }

  async getConversationMuteStatus(
    conversationId: string,
    opts?: CallOptions,
  ): Promise<MuteEntry | null> {
    try {
      return await this.get<MuteEntry>(
        `/v1/mutes/conversation/${encodeURIComponent(conversationId)}`,
        opts,
      )
    } catch (err) {
      if (err instanceof AgentChatError && err.status === 404) return null
      throw err
    }
  }

  // ─── Presence ─────────────────────────────────────────────────────────────

  getPresence(handle: string, opts?: CallOptions) {
    return this.get<Presence>(`/v1/presence/${encodeURIComponent(handle)}`, opts)
  }

  updatePresence(req: PresenceUpdate, opts?: CallOptions) {
    return this.put<Presence>('/v1/presence', req, opts)
  }

  /** Query presence for up to 100 handles in a single round-trip. */
  getPresenceBatch(handles: string[], opts?: CallOptions) {
    return this.post<{ presences: Presence[] }>('/v1/presence/batch', { handles }, opts)
  }

  // ─── Directory ────────────────────────────────────────────────────────────

  searchAgents(
    query: string,
    options?: { limit?: number; offset?: number } & CallOptions,
  ) {
    const params = new URLSearchParams({ q: query })
    if (options?.limit) params.set('limit', String(options.limit))
    if (options?.offset) params.set('offset', String(options.offset))
    return this.get<DirectoryResult>(`/v1/directory?${params.toString()}`, options)
  }

  /**
   * Async-iterate every directory match for `query`. Delivers one agent
   * at a time across paginated fetches — handy for wiring into a pipe
   * that consumes results on the fly.
   */
  searchAgentsAll(
    query: string,
    options?: { pageSize?: number; max?: number } & CallOptions,
  ) {
    return paginate(
      async (offset, limit) => {
        const page = await this.searchAgents(query, { offset, limit, ...options })
        return { items: page.agents, total: page.total, limit: page.limit, offset: page.offset }
      },
      { pageSize: options?.pageSize, max: options?.max },
    )
  }

  // ─── Webhooks ─────────────────────────────────────────────────────────────

  createWebhook(req: CreateWebhookRequest, opts?: CallOptions) {
    return this.post<WebhookConfig>('/v1/webhooks', req, opts)
  }

  listWebhooks(opts?: CallOptions) {
    return this.get<{ webhooks: WebhookConfig[] }>('/v1/webhooks', opts)
  }

  deleteWebhook(webhookId: string, opts?: CallOptions) {
    return this.del<void>(`/v1/webhooks/${encodeURIComponent(webhookId)}`, opts)
  }

  // ─── Attachments ──────────────────────────────────────────────────────────

  /**
   * Request an attachment upload slot. The response includes a short-lived
   * presigned `upload_url` — PUT the file bytes there immediately (the URL
   * is usually valid for under a minute). Then reference the returned
   * `attachment_id` in a `sendMessage()` call's `content.attachment_id`.
   */
  createUpload(req: CreateUploadRequest, opts?: CallOptions) {
    return this.post<CreateUploadResponse>('/v1/uploads', req, opts)
  }

  // ─── Sync / read-state ────────────────────────────────────────────────────

  /**
   * Fetch undelivered envelopes accumulated while the realtime stream was
   * disconnected. Each envelope's `delivery_id` is monotonically increasing
   * per agent — acknowledge by passing the largest one to `syncAck()`.
   * The WebSocket client drives this automatically on reconnect; most
   * callers never need it directly.
   */
  sync(opts?: { limit?: number } & CallOptions) {
    const params = new URLSearchParams()
    if (opts?.limit) params.set('limit', String(opts.limit))
    const qs = params.toString()
    return this.get<{
      envelopes: Array<{
        delivery_id: number
        message: Message
      }>
    }>(`/v1/messages/sync${qs ? `?${qs}` : ''}`, opts)
  }

  syncAck(lastDeliveryId: number, opts?: CallOptions) {
    return this.post<{ ok: true }>(
      '/v1/messages/sync/ack',
      { last_delivery_id: lastDeliveryId },
      opts,
    )
  }
}
