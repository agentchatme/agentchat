import { randomBytes } from 'node:crypto'
import { generateId } from '../lib/id.js'
import {
  createWebhook,
  getWebhooksByAgent,
  getWebhookById,
  deleteWebhook,
  getWebhooksForEvent,
  enqueueWebhookDelivery,
} from '@agentchat/db'
import type { WebhookEvent } from '@agentchat/shared'

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
  // Strip internal agent_id — agent knows it's theirs
  const { agent_id: _, ...safe } = webhook
  return { ...safe, secret }
}

export async function listWebhooks(agentId: string) {
  const webhooks = await getWebhooksByAgent(agentId)
  // Strip secrets and internal agent_id from list response
  return webhooks.map(({ secret: _, agent_id: _a, ...rest }) => rest)
}

export async function getWebhook(id: string, agentId: string) {
  const webhook = await getWebhookById(id)
  if (!webhook || webhook.agent_id !== agentId) {
    throw new WebhookError('NOT_FOUND', 'Webhook not found', 404)
  }
  const { secret: _, agent_id: _a, ...safe } = webhook
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
 * Enqueue webhook deliveries for a specific event on a specific agent.
 *
 * Inserts one row per matching webhook into webhook_deliveries — the
 * background worker (see webhook-worker.ts) picks them up, fires the
 * actual HTTP request, and handles retries with exponential backoff.
 *
 * We keep the function named fireWebhooks to preserve the call sites'
 * semantics — from the caller's perspective, "fire" still means "this
 * event will be delivered eventually." The fan-out just happens via a
 * durable queue now, so a restart mid-delivery doesn't drop events.
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

  // Enqueue one delivery row per webhook. Parallel inserts to keep the
  // calling request latency flat even for agents with the full 5 webhooks.
  await Promise.all(
    webhooks.map((webhook) =>
      enqueueWebhookDelivery({
        id: generateId('whd'),
        webhook_id: webhook.id,
        agent_id: agentId,
        url: webhook.url,
        secret: webhook.secret,
        event,
        payload,
      }).catch((err) => {
        // Enqueue shouldn't normally fail (single INSERT). If it does,
        // we log and move on — better to lose the webhook than fail the
        // message-send request it's attached to. The event is still
        // safely stored in the messages table and will surface via sync.
        console.error('[webhook] enqueue failed:', err)
      }),
    ),
  )
}
