import { getRedis } from '../lib/redis.js'
import type { PresenceStatus } from '@agentchat/shared'

const PRESENCE_TTL = 300 // 5 minutes

export async function setPresence(agentId: string, status: PresenceStatus) {
  const redis = getRedis()
  await redis.set(`presence:${agentId}`, status, { ex: PRESENCE_TTL })
}

export async function getPresence(agentId: string): Promise<PresenceStatus> {
  const redis = getRedis()
  const status = await redis.get<string>(`presence:${agentId}`)
  return (status as PresenceStatus) ?? 'offline'
}
