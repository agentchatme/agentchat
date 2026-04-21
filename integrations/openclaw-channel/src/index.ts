/**
 * Public entry barrel for `@agentchatme/openclaw`.
 *
 * OpenClaw loads this file via `package.json`'s `openclaw.extensions` entry
 * and reads `default` to obtain the channel-entry descriptor.
 * Keep imports narrow so the bootstrap/discovery path stays lightweight
 * (matches the Telegram/Slack extension pattern in openclaw/openclaw).
 */

export {
  agentchatChannelEntry as default,
  agentchatChannelEntry,
  agentchatPlugin,
  AGENTCHAT_CHANNEL_ID,
  AGENTCHAT_DEFAULT_ACCOUNT_ID,
} from './channel.js'
export type { AgentchatResolvedAccount } from './channel.js'

export { agentchatSetupEntry, agentchatSetupPlugin } from './channel.setup.js'

export { agentchatSetupWizard } from './setup-wizard.js'

export { hasAgentChatConfiguredState } from './configured-state.js'

export { parseChannelConfig } from './config-schema.js'
export type { AgentchatChannelConfig } from './config-schema.js'

export { AgentchatChannelRuntime } from './runtime.js'
export type {
  ChannelRuntimeHandlers,
  ChannelRuntimeOptions,
  HealthSnapshot,
} from './runtime.js'

export type {
  NormalizedInbound,
  NormalizedMessage,
  NormalizedReadReceipt,
  NormalizedTyping,
  NormalizedPresence,
  NormalizedRateLimitWarning,
  NormalizedGroupInvite,
  NormalizedGroupDeleted,
  NormalizedUnknown,
  ConversationKind,
} from './inbound.js'

export type {
  OutboundMessageInput,
  OutboundDirectMessage,
  OutboundGroupMessage,
  OutboundBacklogWarning,
  SendResult,
} from './outbound.js'

export type {
  Message,
  MessageContent,
  MessageType,
  MessageStatus,
} from './types/message.js'

export { AgentChatChannelError } from './errors.js'
export type { ErrorClass } from './errors.js'

export type { ConnectionState } from './state-machine.js'

export {
  validateApiKey,
  assertApiKeyValid,
  registerAgentStart,
  registerAgentVerify,
} from './setup-client.js'
export type {
  AgentchatAgentIdentity,
  ValidateApiKeyResult,
  ValidateApiKeyOptions,
  RegisterAgentStartInput,
  RegisterAgentVerifyInput,
  RegisterStartResult,
  RegisterVerifyResult,
  RegisterOptions,
} from './setup-client.js'
