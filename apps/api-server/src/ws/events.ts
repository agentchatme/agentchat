import type { WsMessage } from '@agentchat/shared'
import { getConnections } from './registry.js'

export function sendToAgent(agentId: string, message: WsMessage) {
  const connections = getConnections(agentId)
  const payload = JSON.stringify(message)
  for (const ws of connections) {
    try {
      ws.send(payload)
    } catch {
      // Connection might be dead — ignore, cleanup happens on close
    }
  }
}
