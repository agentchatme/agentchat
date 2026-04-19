import { createHash } from 'node:crypto'
import { AgentChatClient, type SendMessageResult } from 'agentchat'
import { env } from './env.js'
import { Sentry } from './instrument.js'
import { logger } from './lib/logger.js'

// ─── Outbound SDK singleton ────────────────────────────────────────────────
//
// All outbound traffic from chatfather (DM replies, escalation acks,
// welcome messages) flows through this single AgentChatClient instance.
// Reusing one client means we share the underlying fetch keep-alive pool
// and a single retry policy — important because under load chatfather
// might send dozens of replies per second during a sign-up wave.
//
// The API key here is chatfather's own API key, minted via
// /internal/rotate-system-agent-key on the api-server. If we ever run
// multiple system agents, each gets its own client instance — never
// share keys across identities.
let client: AgentChatClient | null = null

function getClient(): AgentChatClient {
  if (!client) {
    client = new AgentChatClient({
      apiKey: env.AGENTCHAT_API_KEY,
      baseUrl: env.AGENTCHAT_BASE_URL,
    })
  }
  return client
}

// ─── Deterministic idempotency key ─────────────────────────────────────────
//
// The api-server dedupes on client_msg_id (migration 010). If chatfather
// crashes mid-reply and the webhook delivery is retried from api-server's
// outbox, or if a future change relaxes the duplicate-delivery short-
// circuit in webhook.ts, we want the SAME idempotent send — the user
// gets the reply once, even if our process tried to send it twice.
//
// Key is derived from:
//   sourceId   — the originating event's identity (message id, or
//                a synthetic "<handle>:agent.created:<created_at>"
//                for welcome DMs) — stable across process restarts.
//   replyText  — the text we're about to send — so that if our code
//                ever recomputes a DIFFERENT reply (say the FAQ
//                changed between the first attempt and the retry),
//                the server treats it as a fresh message rather than
//                deduplicating against the stale one.
//
// Separator byte between the two fields prevents collisions between
// (source="a", reply="bc") and (source="ab", reply="c").
//
// 32 hex chars = 128 bits of entropy — matches the SDK's UUID-based
// default and stays well under the 128-char max on SendMessageRequest.
function deriveClientMsgId(sourceId: string, replyText: string): string {
  const digest = createHash('sha256')
    .update(sourceId)
    .update('\0')
    .update(replyText)
    .digest('hex')
  return `cf_${digest.slice(0, 32)}`
}

/**
 * Send a DM reply to `recipientHandle` with body text.
 *
 * - `to: '@{handle}'` always — even if the triggering message came from a
 *   group, we reply privately. Support conversations don't belong in the
 *   group; the sender always gets a private answer.
 * - `sourceId` anchors the idempotency key — pass the inbound message id
 *   for message replies and a stable synthetic id for welcome DMs. See
 *   deriveClientMsgId() above for the full reasoning.
 *
 * Returns the server's message row on success. Logs and re-throws on
 * error so the caller can decide whether a follow-up action (e.g.
 * writing an escalation row) should still proceed.
 */
export async function sendReply(
  recipientHandle: string,
  text: string,
  sourceId: string,
): Promise<SendMessageResult> {
  const c = getClient()
  const clientMsgId = deriveClientMsgId(sourceId, text)
  try {
    const result = await c.sendMessage({
      to: `@${recipientHandle}`,
      content: { text },
      client_msg_id: clientMsgId,
    })
    logger.info(
      {
        recipient: recipientHandle,
        message_id: result.message.id,
        client_msg_id: clientMsgId,
      },
      'reply_sent',
    )
    return result
  } catch (err) {
    logger.error(
      { err, recipient: recipientHandle, client_msg_id: clientMsgId },
      'reply_send_failed',
    )
    // Reply failures mean the user is sitting in silence — page operators
    // so we catch api-key revocations, outages, or SDK bugs fast. The
    // caller re-throws this anyway, but top-level dispatch swallows it
    // to keep webhook 200s, so Sentry here is the only real signal.
    Sentry.captureException(err, {
      tags: { failure: 'reply_send', recipient: recipientHandle },
    })
    throw err
  }
}
