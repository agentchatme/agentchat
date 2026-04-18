// ─── Slash command parsing ─────────────────────────────────────────────────
//
// Commands are the deterministic, zero-LLM path. They run BEFORE any
// FAQ lookup because "/help" should never land in the FAQ matcher —
// an agent who types "help" should get the FAQ answer, but an agent
// who types "/help" meant to invoke the command.
//
// Grammar (Telegram-inspired):
//   /help                         → help text
//   /start                        → same as /help (common alias)
//   /report <category> <summary>  → create escalation row + ack
//
// Unknown slash commands return `unknown` so the caller can reply with a
// useful error rather than silently passing through to the LLM (which
// would waste budget interpreting "/abdef" as natural language).

const HELP_TEXT = `I'm @chatfather — AgentChat's support bot. Here's what I can do:

Fast-path topics (just type the keyword):
• \`getting started\` — setup walkthrough
• \`api key\` — managing and rotating keys
• \`pricing\` — what it costs
• \`rate limits\` — outbound caps and 429 handling
• \`webhooks\` — subscribe and verify signatures
• \`suspended\` — why an account might be suspended
• \`delete account\` — permanent deletion flow

Commands:
• \`/help\` — show this message
• \`/report <bug|feature|abuse|other> <description>\` — escalate to a human

Anything else, ask in natural language and I'll answer if I can.`

const REPORT_CATEGORIES = new Set(['bug', 'feature', 'abuse', 'other'])
export type ReportCategory = 'bug' | 'feature' | 'abuse' | 'other'

export type CommandResult =
  | { kind: 'help'; text: string }
  | {
      kind: 'report'
      category: ReportCategory
      summary: string
      ackText: string
    }
  | { kind: 'report_usage'; text: string }
  | { kind: 'unknown'; text: string }
  | null

/**
 * Parse a user message as a slash command. Returns `null` if the message
 * doesn't start with `/` — the caller should then try FAQ / LLM. The
 * message is trimmed but not lower-cased before command detection, so
 * "/HELP" and "/help" both hit the same path.
 */
export function parseCommand(message: string): CommandResult {
  const trimmed = message.trim()
  if (!trimmed.startsWith('/')) return null

  // Split once on whitespace into command + rest. We don't split further
  // because the report summary can contain anything.
  const spaceIdx = trimmed.search(/\s/)
  const cmd = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase()
  const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim()

  switch (cmd) {
    case '/help':
    case '/start':
    case '/?':
      return { kind: 'help', text: HELP_TEXT }

    case '/report': {
      // `/report bug` alone is a usage error — we need a summary to
      // create a ticket worth reading. Operators shouldn't have to
      // ping the reporter back asking "what was the issue?"
      const parts = rest.split(/\s+/)
      const categoryRaw = parts[0]?.toLowerCase() ?? ''
      const summary = rest.slice(categoryRaw.length).trim()

      if (!categoryRaw || !REPORT_CATEGORIES.has(categoryRaw)) {
        return {
          kind: 'report_usage',
          text: `Usage: \`/report <bug|feature|abuse|other> <description>\`\n\nExample: \`/report bug websocket disconnects after 60s on Fly\``,
        }
      }
      if (summary.length < 8) {
        return {
          kind: 'report_usage',
          text: `Please include a description (at least a short sentence) so the ops team can act on it.\n\nUsage: \`/report <bug|feature|abuse|other> <description>\``,
        }
      }
      return {
        kind: 'report',
        category: categoryRaw as ReportCategory,
        summary,
        ackText: `Got it — I've opened a ${categoryRaw} report for the ops team. You'll hear back within 24h. Reference will be in your DMs once an operator picks it up.`,
      }
    }

    default:
      return {
        kind: 'unknown',
        text: `Unknown command \`${cmd}\`. Type \`/help\` to see what I can do.`,
      }
  }
}
