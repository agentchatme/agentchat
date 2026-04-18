import type { ReportCategory } from '../fastpath/commands.js'
import { logger } from '../lib/logger.js'
import { chatComplete, OpenRouterError } from './openrouter.js'
import { buildSystemPrompt, sanitizeUserMessage } from './prompt.js'

// ─── LLM-backed answer with grounding ──────────────────────────────────────
//
// Called by the webhook dispatcher when the fast-path router returns
// `{ kind: 'llm' }`. This path is the most expensive one in chatfather
// (the only one that costs real money per call), so most traffic should
// still be served by the fast-path. Rule of thumb: if a question comes
// in twice a week from different agents, it belongs in the FAQ.
//
// Output contract: the LLM either answers directly or emits a literal
// ESCALATE:<category>:<summary> line per the system prompt. We parse
// that line here and convert to the same RouteResult shape the
// fast-path router produces, so webhook.ts can handle both paths
// identically.
//
// Failure modes — all return a graceful reply rather than throw:
//   - Both models fail       → canned "having trouble" message
//   - Model returns garbage  → canned "didn't understand" message
// The caller never needs to try/catch this — errors are logged,
// but the user always gets a real reply.

export type LlmAnswer =
  | {
      kind: 'reply'
      text: string
      model: string
      fromFallback: boolean
      totalTokens: number
    }
  | {
      kind: 'escalate'
      category: ReportCategory
      summary: string
      ackText: string
      model: string
      fromFallback: boolean
      totalTokens: number
    }

const VALID_ESCALATE_CATEGORIES: ReadonlySet<ReportCategory> = new Set<ReportCategory>([
  'bug',
  'feature',
  'abuse',
  'other',
])

const TROUBLE_REPLY = `I'm having trouble looking that up right now — please try again in a minute. If it's urgent, send \`/report other <description>\` and a human will pick it up.`

/**
 * Ask the LLM for an answer grounded on the bundled FAQ + known-issues.
 * Returns a normalized result the caller can act on. Never throws.
 */
export async function answerWithLlm(userText: string): Promise<LlmAnswer> {
  const systemPrompt = buildSystemPrompt()
  const sanitized = sanitizeUserMessage(userText)

  let completion
  try {
    completion = await chatComplete([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: sanitized },
    ])
  } catch (err) {
    // Primary AND fallback both failed. Canned punt — we can't leave
    // the user on silence.
    const status = err instanceof OpenRouterError ? err.status : undefined
    const model = err instanceof OpenRouterError ? err.model : undefined
    logger.error({ err, status, model }, 'llm_both_models_failed')
    return {
      kind: 'reply',
      text: TROUBLE_REPLY,
      model: 'none',
      fromFallback: false,
      totalTokens: 0,
    }
  }

  logger.info(
    {
      model: completion.model,
      from_fallback: completion.fromFallback,
      prompt_tokens: completion.promptTokens,
      completion_tokens: completion.completionTokens,
    },
    'llm_completion_ok',
  )

  const parsed = parseEscalate(completion.text)
  if (parsed) {
    return {
      kind: 'escalate',
      category: parsed.category,
      summary: parsed.summary,
      ackText: `I'll hand this to a human — opened a ${parsed.category} report based on your message. You'll hear back within 24h.`,
      model: completion.model,
      fromFallback: completion.fromFallback,
      totalTokens: completion.totalTokens,
    }
  }

  return {
    kind: 'reply',
    text: completion.text,
    model: completion.model,
    fromFallback: completion.fromFallback,
    totalTokens: completion.totalTokens,
  }
}

/**
 * Parse the literal ESCALATE:<category>:<summary> contract.
 *
 * Valid: `ESCALATE:bug:websocket disconnects after 60s on Fly`
 * Invalid: anything with text before the keyword, unknown category,
 * or empty summary — we return null and the caller treats the output
 * as a regular reply. This is the right default: if the model tries
 * to escalate with malformed output, the user still gets the (partial)
 * reply rather than a silent drop.
 *
 * The keyword check is case-sensitive on purpose. The system prompt
 * asks for uppercase ESCALATE — if the model lowercases it, that's a
 * drift signal we'd rather treat as a reply than coerce into a ticket.
 */
function parseEscalate(
  text: string,
): { category: ReportCategory; summary: string } | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('ESCALATE:')) return null

  const rest = trimmed.slice('ESCALATE:'.length)
  const colon = rest.indexOf(':')
  if (colon === -1) return null

  const category = rest.slice(0, colon).trim().toLowerCase() as ReportCategory
  const summary = rest.slice(colon + 1).trim()

  if (!VALID_ESCALATE_CATEGORIES.has(category)) return null
  if (summary.length < 4) return null

  return { category, summary: summary.slice(0, 500) }
}
