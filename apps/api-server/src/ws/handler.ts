import { createHash } from 'node:crypto'
import { findAgentByApiKeyHash } from '@agentchat/db'
import { addConnection, removeConnection } from './registry.js'
import { syncUndelivered } from '../services/message.service.js'
import { sendToAgent } from './events.js'
import type { WSContext } from 'hono/ws'

export async function authenticateWs(token: string): Promise<string | null> {
  const hash = createHash('sha256').update(token).digest('hex')
  const agent = await findAgentByApiKeyHash(hash)
  if (!agent) return null
  return agent.id
}

export function handleWsConnection(agentId: string, ws: WSContext) {
  addConnection(agentId, ws)

  // On connect, deliver any undelivered messages (sync on reconnect)
  syncUndelivered(agentId)
    .then((messages) => {
      if (messages.length > 0) {
        for (const msg of messages) {
          sendToAgent(agentId, {
            type: 'message.new',
            payload: msg,
          })
        }
      }
    })
    .catch(() => {
      // Non-critical — agent can always call /v1/messages/sync manually
    })

  return {
    onClose: () => {
      removeConnection(agentId, ws)
    },
  }
}
