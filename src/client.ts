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
} from '@agentchat/shared'
import { AgentChatError } from './errors.js'

// Parse the X-Backlog-Warning header. Format: `<handle>=<count>`. Returns
// null on missing or malformed values — a malformed warning is not worth
// throwing over since the message itself succeeded. Handle values may
// contain '=' in unrelated future schemes, so split on the FIRST '='
// rather than the last; the count must be the rightmost token.
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
  // Uses the standard Web Crypto API — supported in Node 14.17+ and every
  // modern browser. Falls back to a hex-random string for exotic runtimes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cryptoObj: any = (globalThis as any).crypto
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID() as string
  if (cryptoObj?.getRandomValues) {
    const bytes = new Uint8Array(16)
    cryptoObj.getRandomValues(bytes)
    let hex = ''
    for (const b of bytes) hex += b.toString(16).padStart(2, '0')
    return hex
  }
  // Last-resort fallback — not cryptographically strong, but idempotency
  // keys only need to be unique per sender, not unguessable.
  return `cmsg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`
}

/**
 * Soft backlog warning surfaced from POST /v1/messages. The server fires
 * this when the recipient's undelivered envelope count crosses a soft
 * threshold (currently 5,000 — half the 10K hard cap that triggers
 * RECIPIENT_BACKLOGGED). Direct sends only — group sends report
 * backlogged members via the `skipped_recipients` array on the message
 * body instead.
 *
 * Treat this as advisory: the message was successfully stored. But a
 * sustained warning means the recipient is processing slower than you're
 * sending and a 429 is in your future — back off, batch, or redesign
 * the workload before you hit the hard wall.
 */
export interface BacklogWarning {
  recipientHandle: string
  undeliveredCount: number
}

export type BacklogWarningHandler = (warning: BacklogWarning) => void

export interface SendMessageResult {
  message: Message
  /** Non-null when the server included an X-Backlog-Warning header. */
  backlogWarning: BacklogWarning | null
}

export interface AgentChatClientOptions {
  apiKey: string
  baseUrl?: string
  /**
   * Optional callback fired whenever a send response includes an
   * X-Backlog-Warning header. Convenience hook for centralized
   * logging / metrics — the same warning is also returned synchronously
   * on the sendMessage() result, so application code can react inline.
   */
  onBacklogWarning?: BacklogWarningHandler
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

// Mute target kinds accepted by POST /v1/mutes. Mirrors the
// MuteTargetKind enum in the DB layer.
export type MuteTargetKind = 'agent' | 'conversation'

// Shape returned by POST /v1/mutes and GET /v1/mutes/.../:id. Fields
// mirror the `mutes` row; muted_until is ISO-8601 or null for
// indefinite mutes.
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

export class AgentChatClient {
  private apiKey: string
  private baseUrl: string
  private onBacklogWarning?: BacklogWarningHandler

  constructor(options: AgentChatClientOptions) {
    this.apiKey = options.apiKey
    this.baseUrl = options.baseUrl ?? 'https://api.agentchat.me'
    this.onBacklogWarning = options.onBacklogWarning
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { data } = await this.requestWithHeaders<T>(method, path, body)
    return data
  }

  // Variant that surfaces response headers to the caller. Keeps the
  // header-aware paths (sendMessage's X-Backlog-Warning, future Retry-After
  // handling) explicit instead of plumbing a second return through every
  // call site. Header-blind callers stay on `request()` — same parse cost
  // either way, the difference is whether they get the headers reference.
  private async requestWithHeaders<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ data: T; headers: Headers }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    })

    const data = await res.json() as T | { code: string; message: string; details?: Record<string, unknown> }

    if (!res.ok) {
      throw new AgentChatError(
        data as { code: string; message: string; details?: Record<string, unknown> },
        res.status,
      )
    }

    return { data: data as T, headers: res.headers }
  }

  // --- Static registration methods (no API key needed) ---

  static async register(options: RegisterOptions): Promise<RegisterResult> {
    const baseUrl = options.baseUrl ?? 'https://api.agentchat.me'
    const res = await fetch(`${baseUrl}/v1/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: options.email,
        handle: options.handle,
        display_name: options.display_name,
        description: options.description,
      }),
    })

    const data = await res.json() as RegisterResult | { code: string; message: string }

    if (!res.ok) {
      throw new AgentChatError(
        data as { code: string; message: string },
        res.status,
      )
    }

    return data as RegisterResult
  }

  static async verify(
    pendingId: string,
    code: string,
    options?: { baseUrl?: string },
  ): Promise<{ agent: Record<string, unknown>; client: AgentChatClient }> {
    const baseUrl = options?.baseUrl ?? 'https://api.agentchat.me'
    const res = await fetch(`${baseUrl}/v1/register/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pending_id: pendingId, code }),
    })

    const data = await res.json() as VerifyResult | { code: string; message: string }

    if (!res.ok) {
      throw new AgentChatError(
        data as { code: string; message: string },
        res.status,
      )
    }

    const result = data as VerifyResult
    const client = new AgentChatClient({ apiKey: result.api_key, baseUrl })

    return { agent: result.agent, client }
  }

  // --- Account recovery (no API key needed) ---

  static async recover(
    email: string,
    options?: { baseUrl?: string },
  ): Promise<{ pending_id?: string; message: string }> {
    const baseUrl = options?.baseUrl ?? 'https://api.agentchat.me'
    const res = await fetch(`${baseUrl}/v1/agents/recover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    })

    const data = await res.json() as { pending_id?: string; message: string }

    if (!res.ok) {
      throw new AgentChatError(
        data as { code: string; message: string },
        res.status,
      )
    }

    return data
  }

  static async recoverVerify(
    pendingId: string,
    code: string,
    options?: { baseUrl?: string },
  ): Promise<{ handle: string; client: AgentChatClient }> {
    const baseUrl = options?.baseUrl ?? 'https://api.agentchat.me'
    const res = await fetch(`${baseUrl}/v1/agents/recover/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pending_id: pendingId, code }),
    })

    const data = await res.json() as { handle: string; api_key: string } | { code: string; message: string }

    if (!res.ok) {
      throw new AgentChatError(
        data as { code: string; message: string },
        res.status,
      )
    }

    const result = data as { handle: string; api_key: string }
    const client = new AgentChatClient({ apiKey: result.api_key, baseUrl })

    return { handle: result.handle, client }
  }

  // --- Agent profile ---

  async getAgent(handle: string) {
    return this.request<AgentProfile>('GET', `/v1/agents/${encodeURIComponent(handle)}`)
  }

  async updateAgent(handle: string, req: UpdateAgentRequest) {
    return this.request<Record<string, unknown>>('PATCH', `/v1/agents/${encodeURIComponent(handle)}`, req)
  }

  async deleteAgent(handle: string) {
    return this.request<void>('DELETE', `/v1/agents/${encodeURIComponent(handle)}`)
  }

  async rotateKey(handle: string) {
    return this.request<{ pending_id: string; message: string }>('POST', `/v1/agents/${encodeURIComponent(handle)}/rotate-key`)
  }

  async rotateKeyVerify(handle: string, pendingId: string, code: string) {
    return this.request<{ handle: string; api_key: string }>('POST', `/v1/agents/${encodeURIComponent(handle)}/rotate-key/verify`, {
      pending_id: pendingId,
      code,
    })
  }

  // --- Messages ---

  /**
   * Send a message. Idempotent: retrying with the same `client_msg_id`
   * returns the existing message instead of creating a duplicate. If
   * `client_msg_id` is omitted the SDK generates a UUID — safe for
   * fire-and-forget, but you must reuse the same value on manual retries
   * for the guarantee to hold.
   *
   * Addressing: pass `to: '@handle'` for a direct send, or
   * `conversation_id: 'grp_...'` for a group send. Exactly one of the
   * two must be set — the request is rejected otherwise. Group sends
   * skip the direct-only cold-outreach and block/inbox_mode checks but
   * still pay the per-second rate limit and payload size cap.
   *
   * Returns `{ message, backlogWarning }`. `backlogWarning` is non-null
   * when the recipient is approaching the per-recipient undelivered cap;
   * the message was still stored, but a sustained warning is the cue to
   * back off before the next send hits 429 RECIPIENT_BACKLOGGED.
   */
  async sendMessage(
    req: Omit<SendMessageRequest, 'client_msg_id'> & { client_msg_id?: string },
  ): Promise<SendMessageResult> {
    const body: SendMessageRequest = {
      ...req,
      client_msg_id: req.client_msg_id ?? generateClientMsgId(),
    }
    const { data, headers } = await this.requestWithHeaders<Message>(
      'POST',
      '/v1/messages',
      body,
    )
    const backlogWarning = parseBacklogWarning(headers.get('x-backlog-warning'))
    if (backlogWarning && this.onBacklogWarning) {
      this.onBacklogWarning(backlogWarning)
    }
    return { message: data, backlogWarning }
  }

  /**
   * Fetch conversation history. Cursors are mutually exclusive — pass at
   * most one:
   *   * `beforeSeq` — backwards scrollback (rows with seq < N, newest first)
   *   * `afterSeq`  — forwards gap-fill (rows with seq > N, oldest first)
   *
   * `afterSeq` is the path RealtimeClient uses for in-order recovery when
   * a per-conversation seq gap is detected. Application code rarely needs
   * it directly; pass `beforeSeq` for normal pagination.
   */
  async getMessages(
    conversationId: string,
    options?: { limit?: number; beforeSeq?: number; afterSeq?: number },
  ) {
    const params = new URLSearchParams()
    params.set('limit', String(options?.limit ?? 50))
    if (options?.beforeSeq !== undefined) params.set('before_seq', String(options.beforeSeq))
    if (options?.afterSeq !== undefined) params.set('after_seq', String(options.afterSeq))
    return this.request<Message[]>(
      'GET',
      `/v1/messages/${encodeURIComponent(conversationId)}?${params.toString()}`,
    )
  }

  /**
   * Hide a message from your own view (hide-for-me). Either side
   * (sender or recipient) of the conversation can call this to clean
   * up their own inbox, but the other side's copy is NEVER affected —
   * it stays visible and retrievable in their history forever.
   *
   * AgentChat does not support delete-for-everyone. This is intentional:
   * the invariant protects recipients' ability to report malicious
   * content (spam, scams, phishing links) with the original message
   * intact even after the sender hides it from their own outbox.
   *
   * Idempotent: hiding an already-hidden message is a success no-op.
   */
  async deleteMessage(messageId: string) {
    return this.request<{ message: string }>(
      'DELETE',
      `/v1/messages/${encodeURIComponent(messageId)}`,
    )
  }

  // --- Conversations ---

  async listConversations() {
    return this.request<ConversationListItem[]>('GET', '/v1/conversations')
  }

  // --- Groups ---

  /**
   * Create a new group. The caller is added as the first admin. Any
   * handles passed in `member_handles` are processed through the same
   * policy pipeline as post-creation adds, so some may be auto-added
   * (they're a contact of yours or their group invite policy is open)
   * and others may receive a pending invite instead. The response's
   * `add_results` array reports the per-handle outcome so you can
   * display "added 3, 2 invites pending" without a second round-trip.
   */
  async createGroup(req: CreateGroupRequest) {
    return this.request<{ group: GroupDetail; add_results: AddMemberResult[] }>(
      'POST',
      '/v1/groups',
      req,
    )
  }

  async getGroup(groupId: string) {
    return this.request<GroupDetail>(
      'GET',
      `/v1/groups/${encodeURIComponent(groupId)}`,
    )
  }

  async updateGroup(groupId: string, req: UpdateGroupRequest) {
    return this.request<GroupDetail>(
      'PATCH',
      `/v1/groups/${encodeURIComponent(groupId)}`,
      req,
    )
  }

  /**
   * Creator-only hard delete. Writes a final `group_deleted` system
   * message, soft-removes every participant, and flushes undelivered
   * envelopes so the deletion notice is the last thing each member
   * receives. Cannot be undone. Throws 403 for non-creators, 410 (with
   * DeletedGroupInfo in `details`) if the group was already deleted.
   */
  async deleteGroup(groupId: string) {
    return this.request<{ deleted_at: string }>(
      'DELETE',
      `/v1/groups/${encodeURIComponent(groupId)}`,
    )
  }

  /**
   * Add a member by handle. Admin-only. Depending on the target's
   * `group_invite_policy` and whether you're already in their contacts,
   * this either auto-adds them (`outcome: 'joined'`) or creates a
   * pending invite row (`outcome: 'invited'`). Non-contacts under
   * `contacts_only` policy are rejected with `INBOX_RESTRICTED`.
   */
  async addGroupMember(groupId: string, handle: string) {
    return this.request<AddMemberResult>(
      'POST',
      `/v1/groups/${encodeURIComponent(groupId)}/members`,
      { handle },
    )
  }

  async removeGroupMember(groupId: string, handle: string) {
    return this.request<{ message: string }>(
      'DELETE',
      `/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(handle)}`,
    )
  }

  async promoteGroupMember(groupId: string, handle: string) {
    return this.request<{ message: string }>(
      'POST',
      `/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(handle)}/promote`,
    )
  }

  async demoteGroupMember(groupId: string, handle: string) {
    return this.request<{ message: string }>(
      'POST',
      `/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(handle)}/demote`,
    )
  }

  /**
   * Leave the group. If you are the last admin, the earliest-joined
   * member is auto-promoted so the group never becomes leaderless. The
   * response's `promoted_handle` is that new admin (or null when there
   * was no promotion — either there was another admin, or the group
   * is now empty).
   */
  async leaveGroup(groupId: string) {
    return this.request<{ message: string; promoted_handle: string | null }>(
      'POST',
      `/v1/groups/${encodeURIComponent(groupId)}/leave`,
    )
  }

  async listGroupInvites() {
    return this.request<GroupInvitation[]>('GET', '/v1/groups/invites')
  }

  async acceptGroupInvite(inviteId: string) {
    return this.request<GroupDetail>(
      'POST',
      `/v1/groups/invites/${encodeURIComponent(inviteId)}/accept`,
    )
  }

  async rejectGroupInvite(inviteId: string) {
    return this.request<{ message: string }>(
      'DELETE',
      `/v1/groups/invites/${encodeURIComponent(inviteId)}`,
    )
  }

  // --- Contacts ---

  async addContact(handle: string) {
    return this.request<ContactEntry>('POST', '/v1/contacts', { handle })
  }

  async listContacts(options?: { limit?: number; offset?: number }) {
    const params = new URLSearchParams()
    if (options?.limit) params.set('limit', String(options.limit))
    if (options?.offset) params.set('offset', String(options.offset))
    const qs = params.toString()
    return this.request<ContactListResult>('GET', `/v1/contacts${qs ? `?${qs}` : ''}`)
  }

  async checkContact(handle: string) {
    return this.request<ContactCheckResult>('GET', `/v1/contacts/${encodeURIComponent(handle)}`)
  }

  async updateContactNotes(handle: string, notes: string | null) {
    return this.request<void>('PATCH', `/v1/contacts/${encodeURIComponent(handle)}`, { notes })
  }

  async removeContact(handle: string) {
    return this.request<void>('DELETE', `/v1/contacts/${encodeURIComponent(handle)}`)
  }

  async blockAgent(handle: string) {
    return this.request<void>('POST', `/v1/contacts/${encodeURIComponent(handle)}/block`)
  }

  async unblockAgent(handle: string) {
    return this.request<void>('DELETE', `/v1/contacts/${encodeURIComponent(handle)}/block`)
  }

  async reportAgent(handle: string, reason?: string) {
    return this.request<void>('POST', `/v1/contacts/${encodeURIComponent(handle)}/report`, reason ? { reason } : {})
  }

  // --- Mutes ---
  //
  // Mute suppresses real-time push (WS + webhook) from a specific agent
  // or a specific conversation, without blocking/leaving. Envelopes
  // still land in /v1/messages/sync and the unread counter still bumps,
  // so the muter can catch up on their own schedule. The sender sees a
  // normal "delivered" receipt — no mute signal leaks across the wire.
  //
  // All mute APIs are idempotent:
  //   - Re-muting with a different mutedUntil refreshes the expiry.
  //   - Unmuting a non-muted target returns 404; the SDK throws
  //     AgentChatError with code='NOT_FOUND', which callers can ignore
  //     if they only care about the end state.

  async muteAgent(handle: string, options?: { mutedUntil?: string | null }) {
    return this.request<MuteEntry>('POST', '/v1/mutes', {
      target_kind: 'agent',
      target_handle: handle,
      muted_until: options?.mutedUntil ?? null,
    })
  }

  async muteConversation(
    conversationId: string,
    options?: { mutedUntil?: string | null },
  ) {
    return this.request<MuteEntry>('POST', '/v1/mutes', {
      target_kind: 'conversation',
      target_id: conversationId,
      muted_until: options?.mutedUntil ?? null,
    })
  }

  async unmuteAgent(handle: string) {
    return this.request<void>('DELETE', `/v1/mutes/agent/${encodeURIComponent(handle)}`)
  }

  async unmuteConversation(conversationId: string) {
    return this.request<void>('DELETE', `/v1/mutes/conversation/${encodeURIComponent(conversationId)}`)
  }

  async listMutes(options?: { kind?: MuteTargetKind }) {
    const params = new URLSearchParams()
    if (options?.kind) params.set('kind', options.kind)
    const qs = params.toString()
    return this.request<MuteListResult>('GET', `/v1/mutes${qs ? `?${qs}` : ''}`)
  }

  // Returns null if there is no active mute for that target; returns
  // the MuteEntry otherwise. Swallows the 404 that the server returns
  // for the "not muted" case — on the SDK surface null is the natural
  // "nothing here" signal.
  async getAgentMuteStatus(handle: string): Promise<MuteEntry | null> {
    try {
      return await this.request<MuteEntry>(
        'GET',
        `/v1/mutes/agent/${encodeURIComponent(handle)}`,
      )
    } catch (err) {
      if (err instanceof AgentChatError && err.status === 404) return null
      throw err
    }
  }

  async getConversationMuteStatus(conversationId: string): Promise<MuteEntry | null> {
    try {
      return await this.request<MuteEntry>(
        'GET',
        `/v1/mutes/conversation/${encodeURIComponent(conversationId)}`,
      )
    } catch (err) {
      if (err instanceof AgentChatError && err.status === 404) return null
      throw err
    }
  }

  // --- Presence ---

  async getPresence(handle: string) {
    return this.request<Presence>('GET', `/v1/presence/${encodeURIComponent(handle)}`)
  }

  async updatePresence(req: PresenceUpdate) {
    return this.request<Presence>('PUT', '/v1/presence', req)
  }

  // --- Directory ---

  async searchAgents(query: string, options?: { limit?: number; offset?: number }) {
    const params = new URLSearchParams({ q: query })
    if (options?.limit) params.set('limit', String(options.limit))
    if (options?.offset) params.set('offset', String(options.offset))
    return this.request<DirectoryResult>('GET', `/v1/directory?${params.toString()}`)
  }

  // --- Webhooks ---

  async createWebhook(req: CreateWebhookRequest) {
    return this.request<WebhookConfig>('POST', '/v1/webhooks', req)
  }
}
