import { CHATFATHER_HANDLE } from '@agentchat/shared'
import { lookupFaq, normalizeForMatch } from '../data/faq.js'
import { parseCommand, type ReportCategory } from './commands.js'

// ─── Fast-path router ──────────────────────────────────────────────────────
//
// Given a message.new webhook payload, decide the shape of the response
// without calling the LLM. Four branches in priority order:
//
//   1. Guards   — skip self, skip no-text, skip obviously-ignored messages
//   2. Commands — /help, /start, /report — deterministic
//   3. Greetings — "hi", "hello", "good morning" — canned welcome
//   4. FAQ      — exact-normalized-keyword match
//   5. LLM      — everything else (task #16 handles this)
//
// ORDER MATTERS. /help must beat FAQ, because "help" is a valid FAQ
// keyword in many dictionaries and "/help" should always invoke the
// command. Greetings beat FAQ because "hello" should never match a
// hypothetical "hello" FAQ entry — the greeting reply is warmer.

// Canonical greeting set. Lowercase; matched against normalizeForMatch()
// output, so punctuation and capitalization in the input are already
// stripped when we check here. Additions over time should pass the
// "could this plausibly NOT be a greeting?" bar — "what's up" means
// greeting in chat but literal question in some locales, so we'd need
// to be conservative about including it.
const GREETINGS: ReadonlySet<string> = new Set([
  'hi',
  'hello',
  'hey',
  'yo',
  'sup',
  'howdy',
  'hi there',
  'hello there',
  'hey there',
  'good morning',
  'good afternoon',
  'good evening',
  'good day',
  'gm',
  'gn',
])

const GREETING_REPLY = `Hey! I'm @chatfather — AgentChat's support bot.

Type \`/help\` to see what I can do, or try asking about \`getting started\`, \`api key\`, \`pricing\`, or \`webhooks\`.`

/**
 * Slice of the message.new webhook payload the router needs. We deliberately
 * don't import the full Message type — it pulls in zod schemas we don't
 * want executed per-message, and we only read a handful of fields.
 */
export interface IncomingMessage {
  id?: string
  conversation_id?: string
  sender?: string
  content?: { text?: string } | null
}

export type RouteResult =
  | { kind: 'reply'; text: string }
  | {
      kind: 'escalate'
      category: ReportCategory
      summary: string
      ackText: string
    }
  | { kind: 'llm'; userText: string }
  | { kind: 'ignore'; reason: string }

export function routeIncomingMessage(data: IncomingMessage): RouteResult {
  const sender = data.sender
  const text = data.content?.text?.trim()

  // No body text — could be an attachment-only message, a data-only
  // message, or an edit event. Fast-path has nothing to do. An LLM
  // pass wouldn't help either without file semantics. Ignore, don't
  // escalate — loud feedback on attachments would feel broken.
  if (!text) return { kind: 'ignore', reason: 'no_text' }

  // Self-echo guard. Chatfather's own replies arrive at its own webhook
  // if a future regression subscribes it to its own outbound events. A
  // loop of "hi" → "hi" would exhaust the LLM budget fast, so we block
  // here rather than depend on that subscription never happening.
  if (sender === CHATFATHER_HANDLE) return { kind: 'ignore', reason: 'self' }

  // Commands first — a user who types "/help" expects the command path,
  // even if "help" happens to be a FAQ keyword.
  const cmd = parseCommand(text)
  if (cmd) {
    if (cmd.kind === 'help' || cmd.kind === 'unknown' || cmd.kind === 'report_usage') {
      return { kind: 'reply', text: cmd.text }
    }
    // cmd.kind === 'report'
    return {
      kind: 'escalate',
      category: cmd.category,
      summary: cmd.summary,
      ackText: cmd.ackText,
    }
  }

  // Greetings and FAQ both operate on the normalized form.
  const normalized = normalizeForMatch(text)
  if (GREETINGS.has(normalized)) {
    return { kind: 'reply', text: GREETING_REPLY }
  }

  const faqAnswer = lookupFaq(text)
  if (faqAnswer) {
    return { kind: 'reply', text: faqAnswer }
  }

  // Everything else — hand off to the LLM. Task #16 fills this path in;
  // until then, webhook.ts answers with a friendly punt.
  return { kind: 'llm', userText: text }
}
