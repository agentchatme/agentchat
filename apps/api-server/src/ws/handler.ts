import { createHash } from 'node:crypto'
import { findAgentByApiKeyHash } from '@agentchat/db'
import { addConnection, removeConnection } from './registry.js'

export async function handleWsUpgrade(token: string): Promise<string | null> {
  const hash = createHash('sha256').update(token).digest('hex')
  const agent = await findAgentByApiKeyHash(hash)
  if (!agent) return null
  return agent.id
}

export { addConnection, removeConnection }
