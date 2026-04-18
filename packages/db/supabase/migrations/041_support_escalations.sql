-- Migration 041: Support-escalation intake table.
--
-- chatfather's last-resort sink when a user either types `/report <category>`
-- or when the LLM decides it cannot confidently answer and emits a
-- literal `ESCALATE:<category>:<summary>` line (see apps/chatfather
-- src/llm/answer.ts). Writing a row here is a precondition for the
-- "handed to a human" ack — we never ack a ticket that doesn't exist.
--
-- Ops drains this table via an internal admin endpoint (plain SELECT);
-- a handful per day does not justify a dashboard view at MVP.
--
-- Denormalized on purpose:
--   - summary is a one-paragraph description of the user's issue
--     (either the /report freetext or the LLM's rewrite)
--   - category is a coarse bucket so ops can slice the backlog without
--     re-reading every row
--   - conversation_id + original_message_id preserve the inbound
--     context for deep-linking back to the thread
--
-- Not a partition target — volume is expected in the tens-per-day, not
-- the millions-per-month that justify messages partitioning.
--
-- Why from_agent_handle (TEXT, no FK) instead of from_agent_id (FK):
--   If an abusive agent deletes their account we still want the
--   moderation history to survive. An FK with ON DELETE CASCADE would
--   wipe the row we filed them for; ON DELETE SET NULL would leave an
--   orphan pointer. Storing the handle at file-time mirrors how
--   message_outbox (migration 031) preserves sender context across GC.
--
-- Why conversation_id without FK: same logic — conversation rows may
-- be GC'd after the escalation is filed, but ops still needs the id for
-- audit correlation with upstream logs.

CREATE TABLE IF NOT EXISTS support_escalations (
  id                  TEXT PRIMARY KEY,
  from_agent_handle   TEXT NOT NULL,
  conversation_id     TEXT NOT NULL,
  original_message_id TEXT NOT NULL,
  category            TEXT NOT NULL
    CHECK (category IN ('bug', 'feature', 'abuse', 'other')),
  summary             TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'in_progress', 'resolved', 'discarded')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at         TIMESTAMPTZ,
  resolved_by         TEXT,
  resolution_note     TEXT
);

-- ─── Indexes ────────────────────────────────────────────────────────────────
-- Hot read path: "show me open escalations newest first". Compound so the
-- index can satisfy both the status filter and the order-by without a sort
-- step. Partial on status IN (open, in_progress) so the index footprint
-- tracks the working set, not the full history.
CREATE INDEX IF NOT EXISTS idx_support_escalations_live
  ON support_escalations(created_at DESC)
  WHERE status IN ('open', 'in_progress');

-- Per-handle history lookup — "has this agent escalated before?" Used
-- when an ops operator is triaging a new report and wants to see prior
-- context, and as a secondary signal if chatfather's safety layer ever
-- wants to damp a flood of escalations from a single source.
CREATE INDEX IF NOT EXISTS idx_support_escalations_handle
  ON support_escalations(from_agent_handle, created_at DESC);
