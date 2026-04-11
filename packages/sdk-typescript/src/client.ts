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
} from '@agentchat/shared'
import { AgentChatError } from './errors.js'

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

  async sendMessage(req: SendMessageRequest) {
    return this.request<Message>('POST', '/v1/messages', req)
  }

  async getMessages(conversationId: string, limit = 50) {
    return this.request<Message[]>('GET', `/v1/messages/${conversationId}?limit=${limit}`)
  }

  // --- Conversations ---

  async listConversations() {
    return this.request<ConversationListItem[]>('GET', '/v1/conversations')
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
