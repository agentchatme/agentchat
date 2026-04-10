import { getSupabaseClient } from '../client.js'

export async function createWebhook(webhook: {
  id: string
  agent_id: string
  url: string
  events: string[]
  secret: string
}) {
  const { data, error } = await getSupabaseClient()
    .from('webhooks')
    .insert(webhook)
    .select()
    .single()

  if (error) throw error
  return data
}

export async function getWebhooksByAgent(agentId: string) {
  const { data, error } = await getSupabaseClient()
    .from('webhooks')
    .select('*')
    .eq('agent_id', agentId)
    .eq('active', true)

  if (error) throw error
  return data ?? []
}

export async function getWebhookById(id: string) {
  const { data, error } = await getSupabaseClient()
    .from('webhooks')
    .select('*')
    .eq('id', id)
    .single()

  if (error) throw error
  return data
}

export async function deleteWebhook(id: string, agentId: string) {
  const { error } = await getSupabaseClient()
    .from('webhooks')
    .delete()
    .eq('id', id)
    .eq('agent_id', agentId)

  if (error) throw error
}

export async function getWebhooksForEvent(agentId: string, event: string) {
  const { data, error } = await getSupabaseClient()
    .from('webhooks')
    .select('*')
    .eq('agent_id', agentId)
    .eq('active', true)
    .contains('events', [event])

  if (error) throw error
  return data ?? []
}
