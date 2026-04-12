-- Migration 014: Per-agent soft-delete ("hide") of conversations
--
-- Agents need a way to clean up their conversation list without destroying
-- the conversation for the other participant. WhatsApp calls this "delete
-- chat" and treats new incoming messages as an automatic unhide — which is
-- the semantics we want here too.
--
-- Implementation: a (agent, conversation) hide row stamps the moment the
-- hide happened. Reads filter out anything with created_at <= hidden_at
-- for that agent, and the conversation disappears from the list for as
-- long as conversations.last_message_at <= hidden_at. The moment a new
-- message lands, last_message_at advances past hidden_at and the
-- conversation naturally resurfaces — no cron, no state machine.
--
-- Why not a boolean `hidden`? Because then "hide + auto-unhide on new
-- message" needs a trigger that either clears the flag or compares
-- timestamps anyway. The timestamp approach collapses both into a single
-- comparison and keeps the write path (DELETE endpoint) a single upsert.
--
-- Re-hiding an already-visible conversation is an UPSERT: set hidden_at
-- to NOW(), which pushes the hide window forward past the current
-- last_message_at and hides the conversation again.

CREATE TABLE conversation_hides (
  agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  -- Everything with created_at <= hidden_at is hidden from this agent's
  -- view of the conversation. A fresh hide sets this to NOW().
  hidden_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, conversation_id)
);

-- Lookups in this file go by agent first (list my hides) and by
-- (agent, conversation) together (did I hide this one, and when). The
-- PK covers both access patterns, so no additional index is needed.
