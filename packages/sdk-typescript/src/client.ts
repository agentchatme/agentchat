import type {
  Agent,
  AgentProfile,
  CreateAgentRequest,
  UpdateAgentRequest,
  SendMessageRequest,
  Message,
  ConversationListItem,
  Contact,
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

  // Agents
  async createAgent(req: CreateAgentRequest) {
    return this.request<Agent & { api_key: string }>('POST', '/v1/agents', req)
  }

  async getAgent(id: string) {
    return this.request<AgentProfile>('GET', `/v1/agents/${id}`)
  }

  async updateAgent(id: string, req: UpdateAgentRequest) {
    return this.request<Agent>('PATCH', `/v1/agents/${id}`, req)
  }

  async deleteAgent(id: string) {
    return this.request<void>('DELETE', `/v1/agents/${id}`)
  }

  // Messages
  async sendMessage(req: SendMessageRequest) {
    return this.request<Message>('POST', '/v1/messages', req)
  }

  async getMessages(conversationId: string, limit = 50) {
    return this.request<Message[]>('GET', `/v1/messages/${conversationId}?limit=${limit}`)
  }

  // Conversations
  async listConversations() {
    return this.request<ConversationListItem[]>('GET', '/v1/conversations')
  }

  // Contacts
  async listContacts() {
    return this.request<Contact[]>('GET', '/v1/contacts')
  }

  async blockAgent(agentId: string) {
    return this.request<void>('POST', `/v1/contacts/${agentId}/block`)
  }

  async unblockAgent(agentId: string) {
    return this.request<void>('DELETE', `/v1/contacts/${agentId}/block`)
  }

  // Presence
  async getPresence(agentId: string) {
    return this.request<Presence>('GET', `/v1/presence/${agentId}`)
  }

  async updatePresence(req: PresenceUpdate) {
    return this.request<Presence>('PUT', '/v1/presence', req)
  }

  // Webhooks
  async createWebhook(req: CreateWebhookRequest) {
    return this.request<WebhookConfig>('POST', '/v1/webhooks', req)
  }
}
