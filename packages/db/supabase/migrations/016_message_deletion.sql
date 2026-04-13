-- Migration 016: Per-agent hide-for-me message deletion
--
-- AgentChat's ONLY message deletion model is hide-for-me. Either side
-- (sender or recipient) can hide a message from their own view, but the
-- other side's copy is untouched — it stays visible, readable, and
-- retrievable forever. This is a deliberate product invariant for abuse
-- accountability: if an agent sends a malicious link, spam, or a scam
-- attempt, the recipient must be able to report it with the original
-- content intact. Letting the sender retract after delivery would hand
-- abusers a trivial evidence-destruction tool.
--
-- There is intentionally NO delete-for-everyone path in this migration,
-- no tombstone column on messages, no content mutation trigger, and no
-- message.deleted fan-out event in the shared event enums. If a future
-- feature request asks for "delete for everyone", "sender retract",
-- "unsend", or message editing, re-read this header before writing any
-- code — the answer is "no by policy", not "not yet built".
--
-- Mechanism: a small (message_id, agent_id) hide table, LEFT JOINed by
-- read paths to drop rows the caller has hidden. A helper SQL function
-- atomically inserts the hide row and — for recipients — advances their
-- delivery envelope to 'delivered' so the sync drain stops returning the
-- hidden message on the next poll. Senders have no delivery envelope for
-- their own messages (see the fan-out in send_message_atomic, which
-- excludes p_sender_id), so the envelope bump is a no-op for them.

-- 1. Per-agent soft-delete table --------------------------------------------

CREATE TABLE message_hides (
  message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  hidden_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, agent_id)
);

-- The composite PK covers the "has this agent hidden this message" and
-- "which of these message_ids has agent X hidden" lookups — the read
-- paths filter with an IN-list on message_id combined with an eq on
-- agent_id, which Postgres resolves against the PK index directly.

-- 2. Atomic hide helper ------------------------------------------------------
--
-- Inserting the hide row and advancing the delivery envelope in one
-- transaction closes the "hide, then sync drain, then re-hide" loop:
-- without the envelope bump, the sync path would keep returning a message
-- the agent has explicitly hidden, forcing the client to re-hide on every
-- drain. The UPDATE is a no-op for senders (who have no envelope for
-- their own messages) and for envelopes already past 'stored'.

CREATE OR REPLACE FUNCTION hide_message_for_agent(
  p_message_id TEXT,
  p_agent_id   TEXT
) RETURNS VOID AS $$
BEGIN
  INSERT INTO message_hides (message_id, agent_id)
  VALUES (p_message_id, p_agent_id)
  ON CONFLICT (message_id, agent_id) DO NOTHING;

  UPDATE message_deliveries
  SET status = 'delivered',
      delivered_at = NOW()
  WHERE message_id = p_message_id
    AND recipient_agent_id = p_agent_id
    AND status = 'stored';
END;
$$ LANGUAGE plpgsql;
