import { randomBytes, createHmac } from 'node:crypto'
import { generateId } from '../lib/id.js'
import {
  createWebhook,
  getWebhooksByAgent,
  getWebhookById,
  deleteWebhook,
  getWebhooksForEvent,
} from '@agentchat/db'
import type { WebhookEvent } from '@agentchat/shared'

const MAX_RETRIES = 3
const RETRY_DELAYS = [1000, 5000, 15000] // 1s, 5s, 15s

export class WebhookError extends Error {
  code: string
  status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'WebhookError'
    this.code = code
    this.status = status
  }
}

export async function registerWebhook(agentId: string, url: string, events: WebhookEvent[]) {
  // Limit to 5 webhooks per agent
  const existing = await getWebhooksByAgent(agentId)
  if (existing.length >= 5) {
    throw new WebhookError('LIMIT_REACHED', 'Maximum 5 webhooks per agent', 400)
  }

  const id = generateId('whk')
  const secret = randomBytes(32).toString('hex')

  const webhook = await createWebhook({
    id,
    agent_id: agentId,
    url,
    events,
    secret,
  })

  // Return with secret visible (shown only on creation, like API keys)
  return { ...webhook, secret }
}

export async function listWebhooks(agentId: string) {
  const webhooks = await getWebhooksByAgent(agentId)
  // Strip secrets from list response
  return webhooks.map(({ secret: _, ...rest }) => rest)
}

export async function getWebhook(id: string, agentId: string) {
  const webhook = await getWebhookById(id)
  if (!webhook || webhook.agent_id !== agentId) {
    throw new WebhookError('NOT_FOUND', 'Webhook not found', 404)
  }
  const { secret: _, ...safe } = webhook
  return safe
}

export async function removeWebhook(id: string, agentId: string) {
  const webhook = await getWebhookById(id)
  if (!webhook || webhook.agent_id !== agentId) {
    throw new WebhookError('NOT_FOUND', 'Webhook not found', 404)
  }
  await deleteWebhook(id, agentId)
}

/**
 * Fire webhooks for a specific event on a specific agent.
 * This is best-effort with retries — failures don't affect message delivery.
 */
export async function fireWebhooks(
  agentId: string,
  event: WebhookEvent,
  data: Record<string, unknown>,
) {
  const webhooks = await getWebhooksForEvent(agentId, event)
  if (webhooks.length === 0) return

  const payload = {
    event,
    timestamp: new Date().toISOString(),
    data,
  }

  // Fire all webhooks concurrently (non-blocking)
  for (const webhook of webhooks) {
    deliverWithRetry(webhook.url, webhook.secret, payload).catch(() => {
      // All retries exhausted — silently fail
      // Message is safe in DB, agent gets it on next sync
    })
  }
}

async function deliverWithRetry(
  url: string,
  secret: string,
  payload: Record<string, unknown>,
  attempt = 0,
): Promise<void> {
  const body = JSON.stringify(payload)

  // HMAC signature so receiver can verify authenticity
  const signature = createHmac('sha256', secret).update(body).digest('hex')

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AgentChat-Signature': signature,
        'X-AgentChat-Event': String(payload.event),
      },
      body,
      signal: AbortSignal.timeout(10_000), // 10s timeout per attempt
    })

    if (!response.ok && attempt < MAX_RETRIES) {
      await delay(RETRY_DELAYS[attempt]!)
      return deliverWithRetry(url, secret, payload, attempt + 1)
    }
  } catch {
    // Network error or timeout
    if (attempt < MAX_RETRIES) {
      await delay(RETRY_DELAYS[attempt]!)
      return deliverWithRetry(url, secret, payload, attempt + 1)
    }
    // All retries exhausted
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
