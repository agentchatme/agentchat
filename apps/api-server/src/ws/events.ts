import type { WsMessage } from '@agentchat/shared'
import { publishToAgent, publishToOwner } from './pubsub.js'

export function sendToAgent(agentId: string, message: WsMessage) {
  // Publishes to Redis for fan-out across all servers.
  // Falls back to local-only delivery if pub/sub is not configured.
  publishToAgent(agentId, message)
}

export function sendToOwner(ownerId: string, event: unknown) {
  // Dashboard read-only channel. Typed loosely because the wire shape is
  // defined by the WIRE-CONTRACT events section, not the shared Zod
  // WsMessage schema (which is agent-facing and validated on the agent side).
  publishToOwner(ownerId, event)
}
