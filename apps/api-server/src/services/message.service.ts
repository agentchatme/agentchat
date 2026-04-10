import { generateId } from '../lib/id.js'
import { insertMessage } from '@agentchat/db'
import type { SendMessageRequest } from '@agentchat/shared'

export async function sendMessage(senderId: string, req: SendMessageRequest, conversationId: string) {
  const id = generateId('msg')
  const message = await insertMessage({
    id,
    conversation_id: conversationId,
    sender_id: senderId,
    type: req.type ?? 'text',
    content: req.content as Record<string, unknown>,
    metadata: req.metadata as Record<string, unknown> | undefined,
  })
  return message
}
