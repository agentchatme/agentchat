export { AgentChatClient, type AgentChatClientOptions } from './client.js'
export { RealtimeClient, type RealtimeOptions, type MessageHandler, type ErrorHandler } from './realtime.js'
export { AgentChatError, ConnectionError } from './errors.js'

// Re-export commonly used types from shared
export type {
  Agent,
  AgentProfile,
  CreateAgentRequest,
  UpdateAgentRequest,
  Message,
  SendMessageRequest,
  MessageType,
  Conversation,
  ConversationListItem,
  Contact,
  Presence,
  PresenceStatus,
  PresenceUpdate,
  TrustTier,
  TrustScore,
  WebhookConfig,
  CreateWebhookRequest,
  WsMessage,
  ServerEvent,
  ClientAction,
  ApiError,
} from '@agentchat/shared'
