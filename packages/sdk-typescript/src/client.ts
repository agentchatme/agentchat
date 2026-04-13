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

export interface AgentChatClientOptions {
  apiKey: string
  baseUrl?: string
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

export class AgentChatClient {
  private apiKey: string
  private baseUrl: string

  constructor(options: AgentChatClientOptions) {
    this.apiKey = options.apiKey
    this.baseUrl = options.baseUrl ?? 'https://api.agentchat.me'
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
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

    return data as T
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
   */
  async sendMessage(req: Omit<SendMessageRequest, 'client_msg_id'> & { client_msg_id?: string }) {
    const body: SendMessageRequest = {
      ...req,
      client_msg_id: req.client_msg_id ?? generateClientMsgId(),
    }
    return this.request<Message>('POST', '/v1/messages', body)
  }

  async getMessages(
    conversationId: string,
    options?: { limit?: number; beforeSeq?: number },
  ) {
    const params = new URLSearchParams()
    params.set('limit', String(options?.limit ?? 50))
    if (options?.beforeSeq !== undefined) params.set('before_seq', String(options.beforeSeq))
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
