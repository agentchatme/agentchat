import type { Context } from 'hono'
import { WebhookPayload, type WebhookEvent } from '@agentchat/shared'
import { env } from './env.js'
import { getRedis } from './lib/redis.js'
import { logger } from './lib/logger.js'
import { verifyWebhookSignature } from './lib/verify.js'
import { routeIncomingMessage, type IncomingMessage } from './fastpath/route.js'
import { buildWelcomeMessage } from './fastpath/welcome.js'
import { sendReply } from './outbound.js'
import { createEscalation } from './escalation.js'
import { answerWithLlm } from './llm/answer.js'
import { checkBurstRate, checkDailyCap, DAILY_CAP_NOTICE } from './safety/rate.js'
import { isNewAgent } from './safety/age.js'
import {
  checkLlmBudget,
  recordLlmUsage,
  BUDGET_EXCEEDED_NOTICE,
} from './safety/budget.js'
import { getCachedLlmReply, setCachedLlmReply } from './safety/dedup.js'

// ─── Webhook ingest ────────────────────────────────────────────────────────
//
// api-server fires webhook_deliveries at us via HTTP POST. Each delivery
// carries:
//   Header  X-AgentChat-Signature   HMAC-SHA256(raw_body, secret) as hex
//   Header  X-AgentChat-Event       event name (duplicated from body.event)
//   Header  X-AgentChat-Delivery    delivery row id (unique per delivery)
//   Body    { event, timestamp, data }
//
// Processing order — each step gates the next:
//
//   1. Parse raw body text (NOT c.req.json() — HMAC is over bytes).
//   2. Verify HMAC. Fail → 401, no body reads past this point.
//   3. Idempotency gate via Redis SETNX with 24h TTL keyed on delivery id.
//      A duplicate returns 200 with `{ duplicate: true }` — api-server
//      retries on 5xx only, so 200 stops the retry loop without re-
//      processing the event.
//   4. Parse + validate body JSON against WebhookPayload schema.
//   5. Dispatch by event type. Unknown events log + 200 (we ignore them
//      silently so api-server doesn't retry, but we never silently drop
//      an event we subscribed to — that would be a config bug worth a
//      loud log line).
//
// Why 24h idempotency TTL: api-server's webhook_deliveries retry budget
// is ~several hours of exponential backoff before DLQ. 24h covers the
// retry window with a comfortable margin for clock skew and scheduled
// redeliveries. Longer TTL wastes Redis memory; shorter risks a retried
// delivery slipping through after the key expires.
//
// Fail-closed on Redis outage: if SETNX throws, we return 503 so api-
// server retries. Alternative (fail open) would double-send welcome DMs
// during an Upstash blip — worse UX than a brief stalled delivery.
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60

export async function handleWebhook(c: Context): Promise<Response> {
  // 1. Raw body — read as text so HMAC is over the exact bytes that
  //    were signed. Hono's c.req.text() returns the request body as
  //    a string; we pass that same string into JSON.parse later.
  let rawBody: string
  try {
    rawBody = await c.req.text()
  } catch (err) {
    logger.warn({ err }, 'webhook_body_read_failed')
    return c.json({ code: 'INVALID_BODY' }, 400)
  }

  // 2. HMAC — run before ANY other body-dependent logic. A request
  //    that fails signature has no legitimate content we should act on.
  const signature = c.req.header('X-AgentChat-Signature')
  if (!verifyWebhookSignature(rawBody, signature, env.OPS_WEBHOOK_SECRET)) {
    // Don't log the full body on failure — it might contain attacker-
    // controlled content. Log the headers that are safe to retain.
    logger.warn(
      {
        delivery_id: c.req.header('X-AgentChat-Delivery'),
        event: c.req.header('X-AgentChat-Event'),
        has_signature: Boolean(signature),
      },
      'webhook_signature_invalid',
    )
    return c.json({ code: 'INVALID_SIGNATURE' }, 401)
  }

  // 3. Idempotency — keyed on the delivery id so retries of the SAME
  //    delivery collapse, but a LEGITIMATE replay of the same event to
  //    a different webhook (if we ever subscribe twice) would carry a
  //    different delivery id and run through. The delivery_id header is
  //    technically outside the HMAC-signed payload, so we also use it
  //    only as an idempotency key — it's not trusted for anything that
  //    would change our behavior on a per-event basis.
  const deliveryId = c.req.header('X-AgentChat-Delivery')
  if (!deliveryId) {
    // No delivery id means no idempotency — refuse. api-server always
    // sends this header, so a missing one is either a misconfigured
    // sender or a forged request. Either way: 400.
    logger.warn('webhook_missing_delivery_id')
    return c.json({ code: 'MISSING_DELIVERY_ID' }, 400)
  }

  const redis = getRedis()
  let firstSeen: boolean
  try {
    // SET key value NX EX seconds — atomic "claim this delivery."
    // Upstash returns 'OK' when the key was created, null when it
    // already existed.
    const result = await redis.set(
      `wh:delivery:${deliveryId}`,
      '1',
      { nx: true, ex: IDEMPOTENCY_TTL_SECONDS },
    )
    firstSeen = result === 'OK'
  } catch (err) {
    logger.error({ err, delivery_id: deliveryId }, 'webhook_idempotency_check_failed')
    return c.json({ code: 'IDEMPOTENCY_UNAVAILABLE' }, 503)
  }

  if (!firstSeen) {
    // Duplicate — api-server already got a 200 from us once; this is
    // almost certainly a retry after a network blip. 200 stops the
    // retry loop. Don't reprocess — we don't know if the original
    // delivery partially succeeded, and re-running could double-send
    // a welcome DM.
    logger.info({ delivery_id: deliveryId }, 'webhook_duplicate')
    return c.json({ ok: true, duplicate: true })
  }

  // 4. Parse + validate. We trust the bytes at this point (HMAC passed)
  //    but validate the JSON shape because a schema mismatch is the one
  //    thing we want to catch early — it means the api-server and
  //    chatfather drifted on the WebhookPayload contract.
  let parsedBody: unknown
  try {
    parsedBody = JSON.parse(rawBody)
  } catch {
    logger.error({ delivery_id: deliveryId }, 'webhook_body_not_json')
    return c.json({ code: 'INVALID_JSON' }, 400)
  }

  const payloadResult = WebhookPayload.safeParse(parsedBody)
  if (!payloadResult.success) {
    logger.error(
      { delivery_id: deliveryId, errors: payloadResult.error.flatten() },
      'webhook_payload_invalid',
    )
    return c.json({ code: 'INVALID_PAYLOAD' }, 400)
  }

  const { event, data } = payloadResult.data

  // 5. Dispatch. Each handler is fire-and-forget — if the event handler
  //    throws, we log and still return 200. Reason: the api-server outbox
  //    already persisted the delivery as "delivered" when our 200 landed,
  //    and returning 5xx on a post-verify handler error would double-send
  //    (we already burned the idempotency slot). Better to land a loud
  //    error log and fix the bug than to retry uselessly.
  try {
    await dispatchEvent(event, data, deliveryId)
  } catch (err) {
    logger.error(
      { err, event, delivery_id: deliveryId },
      'webhook_dispatch_failed',
    )
    // Intentional: still 200. See comment above.
  }

  return c.json({ ok: true })
}

// ─── Event dispatch ────────────────────────────────────────────────────────
//
// message.new → fast-path router (task #15). When the router says
// 'llm', we currently reply with a punt message; task #16 wires in
// OpenRouter.
//
// agent.created → welcome DM, sent exactly once per new agent. Duplicate
// deliveries are already collapsed by the SETNX idempotency gate above,
// so we don't need a second guard here.
async function dispatchEvent(
  event: WebhookEvent,
  data: Record<string, unknown>,
  deliveryId: string,
): Promise<void> {
  switch (event) {
    case 'message.new':
      await handleIncomingMessage(data, deliveryId)
      return

    case 'agent.created':
      await handleAgentCreated(data, deliveryId)
      return

    default:
      // Subscribed to an event we don't handle yet. Config drift — loud
      // log so it surfaces in review rather than getting silently dropped.
      logger.warn({ event, delivery_id: deliveryId }, 'webhook_unhandled_event')
      return
  }
}

async function handleIncomingMessage(
  raw: Record<string, unknown>,
  deliveryId: string,
): Promise<void> {
  const data = raw as IncomingMessage
  const result = routeIncomingMessage(data)
  const sender = data.sender

  // Idempotency anchor for every outbound reply triggered by this
  // event. `data.id` is the inbound message id (required by the
  // Message schema, so always present on a well-formed message.new);
  // deliveryId is the safety net if the shape is ever violated. Using
  // this id — combined with the reply text inside deriveClientMsgId —
  // means a retried delivery that recomputes the same reply dedupes
  // against the first attempt at the server layer.
  const sourceId = data.id ?? `delivery:${deliveryId}`

  logger.info(
    {
      delivery_id: deliveryId,
      sender,
      conversation_id: data.conversation_id,
      route: result.kind,
    },
    'webhook_message_routed',
  )

  if (result.kind === 'ignore') return
  if (!sender) {
    // No sender handle on a routable message — shape violation we'd
    // never expect from api-server. Log and abandon; replying with
    // `to: '@undefined'` would land on a real account literally
    // named "undefined" if someone ever grabs the handle.
    logger.error({ delivery_id: deliveryId, data: raw }, 'webhook_missing_sender')
    return
  }

  // ─── Safety gates ────────────────────────────────────────────────────
  // Ordered cheapest-first. Burst is a single Redis INCR; age touches a
  // cached Supabase row only on cache miss; daily cap is another INCR.
  // Each gate short-circuits: a spammy sender never reaches the LLM
  // path, which is both the slowest and the only one that costs money.
  const burst = await checkBurstRate(sender)
  if (!burst.allowed) {
    // Silent drop on burst — don't give a runaway script a reply to
    // react to. If it's a human mis-tapping, they'll try again in 30s.
    logger.info(
      { delivery_id: deliveryId, sender, current: burst.current, cap: burst.cap },
      'webhook_burst_rate_dropped',
    )
    return
  }

  const isNew = await isNewAgent(sender)
  const daily = await checkDailyCap(sender, isNew)
  if (!daily.allowed) {
    if (daily.firstOverflow) {
      // One-time-per-day throttle notice. Subsequent silent drops today.
      logger.info(
        { delivery_id: deliveryId, sender, current: daily.current, cap: daily.cap },
        'webhook_daily_cap_first_overflow',
      )
      await sendReply(sender, DAILY_CAP_NOTICE, sourceId)
    } else {
      logger.info(
        { delivery_id: deliveryId, sender, current: daily.current, cap: daily.cap },
        'webhook_daily_cap_silent_drop',
      )
    }
    return
  }

  if (result.kind === 'reply') {
    await sendReply(sender, result.text, sourceId)
    return
  }

  if (result.kind === 'escalate') {
    await processEscalation(
      sender,
      data,
      sourceId,
      {
        category: result.category,
        summary: result.summary,
        ackText: result.ackText,
      },
    )
    return
  }

  // result.kind === 'llm' — three gates before we pay OpenRouter:
  //   a) Content-hash cache: exact-duplicate paraphrases from different
  //      senders hit this within the 10-minute TTL.
  //   b) Global daily budget: hard cap on fleet-wide token spend.
  //   c) answerWithLlm itself, which already handles model-level fallback
  //      and never throws — so we don't wrap it in try/catch here.
  const cached = await getCachedLlmReply(result.userText)
  if (cached) {
    logger.info({ delivery_id: deliveryId, sender }, 'webhook_llm_cache_hit')
    await sendReply(sender, cached, sourceId)
    return
  }

  const budget = await checkLlmBudget()
  if (!budget.allowed) {
    logger.warn(
      { delivery_id: deliveryId, used: budget.used, cap: budget.cap },
      'webhook_llm_budget_exceeded',
    )
    await sendReply(sender, BUDGET_EXCEEDED_NOTICE, sourceId)
    return
  }

  const llm = await answerWithLlm(result.userText)

  // Record usage BEFORE replying — a crash between reply and record
  // would under-count, and we'd rather slightly over-throttle tomorrow
  // than under-throttle a runaway model.
  if (llm.totalTokens > 0) {
    await recordLlmUsage(llm.totalTokens)
  }

  if (llm.kind === 'reply') {
    // Cache replies keyed on the NORMALIZED user text — escalations are
    // unique per-ticket and explicitly NOT cached by setCachedLlmReply's
    // contract (the function only writes; it's the caller's job to skip
    // on non-reply kinds).
    await setCachedLlmReply(result.userText, llm.text)
    await sendReply(sender, llm.text, sourceId)
    return
  }
  // llm.kind === 'escalate' — treat identically to a /report command,
  // just with the category/summary the model picked.
  await processEscalation(sender, data, sourceId, {
    category: llm.category,
    summary: llm.summary,
    ackText: llm.ackText,
  })
}

// Common escalation path: DB write first, ack second, so the user never
// hears "opened a ticket" when no ticket actually exists.
async function processEscalation(
  sender: string,
  data: IncomingMessage,
  sourceId: string,
  input: {
    category: Parameters<typeof createEscalation>[0]['category']
    summary: string
    ackText: string
  },
): Promise<void> {
  try {
    await createEscalation({
      fromHandle: sender,
      conversationId: data.conversation_id,
      originalMessageId: data.id,
      category: input.category,
      summary: input.summary,
    })
  } catch (err) {
    logger.error({ err, sender }, 'escalation_create_failed')
    await sendReply(
      sender,
      `I hit an error recording that report — please try again in a minute. If it keeps failing, reply with "urgent" and I'll flag it for the on-call human.`,
      sourceId,
    )
    return
  }
  await sendReply(sender, input.ackText, sourceId)
}

async function handleAgentCreated(
  raw: Record<string, unknown>,
  deliveryId: string,
): Promise<void> {
  const handle = typeof raw.handle === 'string' ? raw.handle : null
  const displayName = typeof raw.display_name === 'string' ? raw.display_name : null
  const createdAt = typeof raw.created_at === 'string' ? raw.created_at : ''

  if (!handle) {
    logger.error({ delivery_id: deliveryId, data: raw }, 'webhook_agent_created_missing_handle')
    return
  }

  const text = buildWelcomeMessage({ handle, display_name: displayName })
  // Synthetic source id for the welcome DM — agent.created carries no
  // explicit event id. `<handle>:agent.created:<created_at>` is stable
  // across webhook retries (api-server's outbox resends with the same
  // payload) AND stable across chatfather redeploys, so a crash between
  // SETNX claim and sendReply still results in exactly one welcome DM.
  const sourceId = `${handle}:agent.created:${createdAt}`
  await sendReply(handle, text, sourceId)
}
