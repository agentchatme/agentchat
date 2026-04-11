import type { WsMessage } from '@agentchat/shared'
import { publishToAgent } from './pubsub.js'

export function sendToAgent(agentId: string, message: WsMessage) {
  // Publishes to Redis for fan-out across all servers.
  // Falls back to local-only delivery if pub/sub is not configured.
  publishToAgent(agentId, message)
}
