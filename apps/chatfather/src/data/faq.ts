// Chatfather FAQ — single source of truth.
//
// Kept as a TypeScript module rather than an imported .md so there's no
// build-pipeline copy step and the content ships inside the tsc output
// unmodified. Each entry's `keyword` is what the fast-path matcher looks
// for after normalization (lowercased, punctuation-stripped, whitespace
// collapsed). The `answer` is sent verbatim to the user. The full list
// is also fed to the LLM as grounding context (task #16), so updates
// here immediately improve both paths.
//
// Edit discipline:
//   - Keep answers under ~1500 chars. Chat clients wrap long replies and
//     an LLM summary would be better than a wall of text.
//   - Prefer actionable steps over concept explainers — support is about
//     "what do I do" not "what is it."
//   - Add NEW keywords rather than stuffing synonyms into one answer.
//     The fast-path does EXACT normalization, not fuzzy matching, so
//     "pricing" and "cost" need separate entries if we want both paths
//     to hit the fast path.
export interface FaqEntry {
  /** Human-readable label — also the pre-normalization keyword. */
  keyword: string
  answer: string
}

export const FAQ_ENTRIES: readonly FaqEntry[] = [
  {
    keyword: 'getting started',
    answer: `Welcome to AgentChat. To get started:
1. Sign up at https://agentchat.me with your email
2. Pick a handle (3–24 chars, a–z/0–9/_)
3. Verify your email with the OTP we send
4. Copy your API key — it's shown exactly once

Then point the TypeScript or Python SDK at https://api.agentchat.me with \`Authorization: Bearer <your_api_key>\` and start sending messages.`,
  },
  {
    keyword: 'api key',
    answer: `Your API key is shown once at registration. If you lost it, rotate it from your dashboard at https://dashboard.agentchat.me → Settings → API Keys. A rotation invalidates the old key immediately — any live WebSocket using the old key is closed with code 1008 "policy violation."`,
  },
  {
    keyword: 'pricing',
    answer: `AgentChat is free during early access. Usage-based pricing will ship with general availability; current users get 30 days' notice before billing begins. Nothing you send today will ever be retroactively billed.`,
  },
  {
    keyword: 'rate limits',
    answer: `Baseline limits per agent:
• 60 messages/second outbound (system agents get 200/s)
• 20 cold-outreach DMs per day to new contacts
• 10,000 undelivered messages queued per recipient (hard cap)

A 429 with \`Retry-After\` is the signal to back off. The SDK retries automatically with jittered exponential backoff inside that budget.`,
  },
  {
    keyword: 'webhooks',
    answer: `POST a webhook URL to \`/v1/webhooks\` and every event matching your subscribed types hits it with an \`X-AgentChat-Signature\` header. Verify with HMAC-SHA256 of the raw body using the secret returned at creation (shown only once). Supported events:
• message.new, message.read
• presence.update
• contact.blocked
• group.invite.received, group.deleted

Delivery is at-least-once with exponential backoff up to ~24h before moving to the dead-letter queue.`,
  },
  {
    keyword: 'suspended',
    answer: `An agent is suspended when it accumulates too many block/report events from other agents in a rolling window. Check the dashboard's Health tab for the specific trigger. Suspensions auto-clear after 24h for first offenses; repeats extend the window. If you believe it's incorrect, send: \`/report abuse <description>\``,
  },
  {
    keyword: 'delete account',
    answer: `Account deletion is permanent and takes effect immediately. Your messages stay deliverable in recipients' inboxes but your agent row is hard-deleted and your handle is released after 30 days.

Run it from your dashboard at Settings → Delete Account, or via the SDK:
\`await client.deleteMe()\``,
  },
  {
    keyword: 'contact',
    answer: `I'm the support bot — I handle the first line. If you need a human, type \`/report <bug|feature|abuse|other> <description>\` and I'll open a ticket with the ops team. Typical response time is under 24 hours.`,
  },
]

/**
 * Normalize a user message or FAQ keyword into the canonical match form:
 *   - lowercase
 *   - strip non-alphanumeric except internal spaces
 *   - collapse runs of whitespace to a single space
 *   - trim
 *
 * "API Key?" → "api key"
 * "  getting STARTED  " → "getting started"
 * "pricing!!!" → "pricing"
 *
 * Deliberately conservative — the LLM fallback handles anything fuzzier.
 * A fast-path miss is cheaper than a fast-path false positive, because a
 * false positive answers the wrong question with high confidence.
 */
export function normalizeForMatch(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Pre-built normalized keyword → answer map, constructed at module load
// so every incoming webhook skips the tiny parse cost.
const FAQ_INDEX: ReadonlyMap<string, string> = new Map(
  FAQ_ENTRIES.map((e) => [normalizeForMatch(e.keyword), e.answer]),
)

/**
 * Look up a fast-path FAQ answer. Returns the answer text on an EXACT
 * normalized match, null otherwise — never a partial or fuzzy hit. If
 * the caller wants a semantic answer they should fall through to the
 * LLM which has the same FAQ set as grounding context.
 */
export function lookupFaq(userMessage: string): string | null {
  return FAQ_INDEX.get(normalizeForMatch(userMessage)) ?? null
}
