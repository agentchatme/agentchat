import type { WsMessage } from '@agentchat/shared'
import { getConnections } from './registry.js'

export function sendToAgent(agentId: string, message: WsMessage) {
  const connections = getConnections(agentId)
  const payload = JSON.stringify(message)
  for (const ws of connections) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload)
    }
  }
}
