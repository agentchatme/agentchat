import type { ReportCategory } from './fastpath/commands.js'
import { generateId } from './lib/id.js'
import { logger } from './lib/logger.js'
import { getSupabase } from './lib/supabase.js'

// ─── Support escalation queue ──────────────────────────────────────────────
//
// Two paths land here:
//   1. A user types `/report <category> <summary>` — fast-path router
//      returns `{ kind: 'escalate' }` and webhook.ts calls us.
//   2. The LLM emits a literal `ESCALATE:<category>:<summary>` line
//      when it cannot answer confidently (see src/llm/answer.ts).
//
// Contract: this function MUST durably persist a row before returning.
// webhook.ts sends the "a human will follow up" ack ONLY after a
// successful return — throwing here makes the ack path short-circuit
// into an error reply. This ordering guarantees we never lie to a user
// about a ticket that doesn't exist.
//
// Schema alignment: columns in support_escalations (migration 041) are
// NOT NULL for conversation_id and original_message_id. The message.new
// webhook always carries both (Message zod schema requires them), so we
// treat missing values as a contract violation — log a loud error and
// refuse to file an incomplete row. An ops operator reading an
// escalation with placeholder ids would chase a dead-end when triaging.

export interface EscalationInput {
  fromHandle: string
  conversationId: string | undefined
  originalMessageId: string | undefined
  category: ReportCategory
  summary: string
}

export interface EscalationRow {
  id: string
}

export async function createEscalation(
  input: EscalationInput,
): Promise<EscalationRow> {
  if (!input.conversationId || !input.originalMessageId) {
    // Shape violation from api-server — message.new is required to
    // carry both ids. Refuse to file a ticket with holes; caller
    // treats a throw as a user-visible error.
    logger.error(
      {
        from_handle: input.fromHandle,
        has_conversation: Boolean(input.conversationId),
        has_message: Boolean(input.originalMessageId),
      },
      'escalation_missing_context_ids',
    )
    throw new Error('escalation_missing_context_ids')
  }

  const id = generateId('esc')
  const sb = getSupabase()

  const { error } = await sb.from('support_escalations').insert({
    id,
    from_agent_handle: input.fromHandle,
    conversation_id: input.conversationId,
    original_message_id: input.originalMessageId,
    category: input.category,
    summary: input.summary,
    // status/created_at default to 'open' / NOW() server-side.
  })

  if (error) {
    logger.error(
      {
        err: error,
        from_handle: input.fromHandle,
        category: input.category,
      },
      'escalation_insert_failed',
    )
    throw new Error('escalation_insert_failed')
  }

  logger.info(
    {
      escalation_id: id,
      from_handle: input.fromHandle,
      category: input.category,
      conversation_id: input.conversationId,
    },
    'escalation_created',
  )

  return { id }
}
