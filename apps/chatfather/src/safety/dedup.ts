import { createHash } from 'node:crypto'
import { getRedis } from '../lib/redis.js'
import { logger } from '../lib/logger.js'

// ─── Content-hash response cache ───────────────────────────────────────────
//
// Many support questions arrive verbatim-identical across senders:
//   "how do i get an api key"
//   "what's your pricing"
//   "is the platform free"
//
// The fast-path exact-keyword matcher catches a lot of them, but:
//   - Paraphrases like "how do I get an API key?" (capital+punctuation)
//     get past the fast-path and go to the LLM. The LLM produces the
//     same answer each time because temperature is 0.2 and the prompt
//     is stable.
//   - Caching the LLM reply for 10 minutes under a hash of the NORMALIZED
//     user text lets the second sender get an instant answer for free.
//
// Scope — ONLY the LLM path. Fast-path replies are already instant;
// caching them adds overhead without latency benefit. Escalation replies
// are not cached because each escalation is a unique ticket (caching
// would also break the mapping between the ack text and the row id
// once #18's real escalation path is wired — planned ahead of time).
//
// Privacy — the cache key is only the user TEXT, not the sender handle.
// This is fine for FAQ-shaped questions which are not personal, and the
// cache holds the assistant's reply not the user's message content, so
// nothing sensitive is stored. If a user's question itself contained
// personal data, the normalization strips case+punctuation but keeps
// content — we accept this tradeoff because chatfather isn't in a
// medical/financial domain.

const CACHE_TTL_SECONDS = 10 * 60

function hashOf(userText: string): string {
  return createHash('sha256')
    .update(userText.trim().toLowerCase())
    .digest('hex')
    .slice(0, 24)
}

export async function getCachedLlmReply(userText: string): Promise<string | null> {
  const redis = getRedis()
  try {
    const raw = await redis.get<string>(`cf:dedup:${hashOf(userText)}`)
    return typeof raw === 'string' ? raw : null
  } catch (err) {
    logger.warn({ err }, 'dedup_read_failed')
    return null
  }
}

export async function setCachedLlmReply(
  userText: string,
  replyText: string,
): Promise<void> {
  // Don't cache very long replies — if the LLM went off-template we
  // don't want to propagate that to future askers.
  if (replyText.length > 2000) return

  const redis = getRedis()
  try {
    await redis.set(`cf:dedup:${hashOf(userText)}`, replyText, {
      ex: CACHE_TTL_SECONDS,
    })
  } catch (err) {
    logger.warn({ err }, 'dedup_write_failed')
  }
}
