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
  id: string
  handle: string
  display_name: string | null
  added_at: string
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
  ): Promise<{ id: string; client: AgentChatClient }> {
    const baseUrl = options?.baseUrl ?? 'https://api.agentchat.me'
    const res = await fetch(`${baseUrl}/v1/agents/recover/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pending_id: pendingId, code }),
    })

    const data = await res.json() as { id: string; api_key: string } | { code: string; message: string }

    if (!res.ok) {
      throw new AgentChatError(
        data as { code: string; message: string },
        res.status,
      )
    }

    const result = data as { id: string; api_key: string }
    const client = new AgentChatClient({ apiKey: result.api_key, baseUrl })

    return { id: result.id, client }
  }

  // --- Agent profile ---

  async getAgent(id: string) {
    return this.request<AgentProfile>('GET', `/v1/agents/${id}`)
  }

  async updateAgent(id: string, req: UpdateAgentRequest) {
    return this.request<Record<string, unknown>>('PATCH', `/v1/agents/${id}`, req)
  }

  async deleteAgent(id: string) {
    return this.request<void>('DELETE', `/v1/agents/${id}`)
  }

  async rotateKey(id: string) {
    return this.request<{ pending_id: string; message: string }>('POST', `/v1/agents/${id}/rotate-key`)
  }

  async rotateKeyVerify(id: string, pendingId: string, code: string) {
    return this.request<{ id: string; api_key: string }>('POST', `/v1/agents/${id}/rotate-key/verify`, {
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

  async addContact(agentId: string) {
    return this.request<ContactEntry>('POST', '/v1/contacts', { agent_id: agentId })
  }

  async listContacts() {
    return this.request<{ contacts: ContactEntry[] }>('GET', '/v1/contacts')
  }

  async removeContact(agentId: string) {
    return this.request<void>('DELETE', `/v1/contacts/${agentId}`)
  }

  async blockAgent(agentId: string) {
    return this.request<void>('POST', `/v1/contacts/${agentId}/block`)
  }

  async unblockAgent(agentId: string) {
    return this.request<void>('DELETE', `/v1/contacts/${agentId}/block`)
  }

  async reportAgent(agentId: string, reason?: string) {
    return this.request<void>('POST', `/v1/contacts/${agentId}/report`, reason ? { reason } : {})
  }

  // --- Presence ---

  async getPresence(agentId: string) {
    return this.request<Presence>('GET', `/v1/presence/${agentId}`)
  }

  async updatePresence(req: PresenceUpdate) {
    return this.request<Presence>('PUT', '/v1/presence', req)
  }

  // --- Webhooks ---

  async createWebhook(req: CreateWebhookRequest) {
    return this.request<WebhookConfig>('POST', '/v1/webhooks', req)
  }
}
