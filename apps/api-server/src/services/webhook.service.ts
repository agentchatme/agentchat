import type { WebhookPayload } from '@agentchat/shared'

export async function deliverWebhook(url: string, secret: string, payload: WebhookPayload) {
  const body = JSON.stringify(payload)
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-AgentChat-Secret': secret,
    },
    body,
    signal: AbortSignal.timeout(10000),
  })
  return response.ok
}
