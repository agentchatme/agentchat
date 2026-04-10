import { getSupabaseClient } from '../client.js'

export async function isBlocked(blockerId: string, blockedId: string) {
  const { data } = await getSupabaseClient()
    .from('blocks')
    .select('blocker_id')
    .eq('blocker_id', blockerId)
    .eq('blocked_id', blockedId)
    .single()
  return !!data
}

export async function blockAgent(blockerId: string, blockedId: string) {
  const { error } = await getSupabaseClient()
    .from('blocks')
    .upsert({ blocker_id: blockerId, blocked_id: blockedId })
  if (error) throw error
}

export async function unblockAgent(blockerId: string, blockedId: string) {
  const { error } = await getSupabaseClient()
    .from('blocks')
    .delete()
    .eq('blocker_id', blockerId)
    .eq('blocked_id', blockedId)
  if (error) throw error
}
