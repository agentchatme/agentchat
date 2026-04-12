-- Migration 011: Per-recipient message delivery tracking
--
-- Prior to this migration, messages.status/delivered_at/read_at tracked a
-- single status per message. That model only holds for 1:1 conversations and
-- becomes incorrect the moment you have multiple recipients: one recipient's
-- "read" shouldn't pin the status for everyone else, and one recipient's
-- outage shouldn't block the rest.
--
-- This migration moves delivery state to a new message_deliveries table:
-- one row per (message_id, recipient_agent_id). It backfills existing rows
-- by fanning out each message to its non-sender participants, then drops
-- the obsolete columns from messages.
--
-- send_message_atomic() is extended to insert the delivery rows atomically
-- in the same transaction as the message — no fan-out window where the
-- message exists without its envelopes.

-- 1. message_deliveries table -------------------------------------------------

CREATE TABLE message_deliveries (
  id                  TEXT PRIMARY KEY,
  message_id          TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  recipient_agent_id  TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'stored'
    CHECK (status IN ('stored', 'delivered', 'read')),
  delivered_at        TIMESTAMPTZ,
  read_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (message_id, recipient_agent_id)
);

-- Sync lookup: "give me my pending deliveries, oldest first".
-- Partial index on status='stored' keeps it tight (95% of rows will be
-- delivered/read and are irrelevant to this query).
CREATE INDEX idx_md_recipient_stored
  ON message_deliveries(recipient_agent_id, created_at ASC)
  WHERE status = 'stored';

-- Lookup delivery rows for a given message (read-receipt composition, etc.)
CREATE INDEX idx_md_message ON message_deliveries(message_id);

-- 2. Backfill existing messages ----------------------------------------------
--
-- For each message, create a delivery row for every non-sender participant
-- of its conversation. Copy the current status/delivered_at/read_at — that's
-- the best approximation we have of per-recipient state from the
-- one-status-per-message column world. For 1:1 conversations this is exactly
-- accurate. No groups exist yet, so no group-specific backfill is needed.

INSERT INTO message_deliveries (
  id, message_id, recipient_agent_id, status, delivered_at, read_at, created_at
)
SELECT
  'del_' || replace(gen_random_uuid()::text, '-', ''),
  m.id,
  cp.agent_id,
  m.status,
  m.delivered_at,
  m.read_at,
  m.created_at
FROM messages m
JOIN conversation_participants cp ON cp.conversation_id = m.conversation_id
WHERE cp.agent_id <> m.sender_id
ON CONFLICT (message_id, recipient_agent_id) DO NOTHING;

-- 3. Rewrite send_message_atomic to fan-out delivery rows atomically ---------
--
-- Signature changes: the RETURNS TABLE no longer carries status/delivered_at/
-- read_at because those live on message_deliveries now. DROP the old
-- definition first so PostgreSQL doesn't complain about the return-shape
-- change.

DROP FUNCTION IF EXISTS send_message_atomic(TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB);

CREATE OR REPLACE FUNCTION send_message_atomic(
  p_message_id      TEXT,
  p_conversation_id TEXT,
  p_sender_id       TEXT,
  p_client_msg_id   TEXT,
  p_type            TEXT,
  p_content         JSONB,
  p_metadata        JSONB
) RETURNS TABLE(
  id              TEXT,
  conversation_id TEXT,
  sender_id       TEXT,
  client_msg_id   TEXT,
  seq             BIGINT,
  type            TEXT,
  content         JSONB,
  metadata        JSONB,
  created_at      TIMESTAMPTZ,
  is_replay       BOOLEAN
) AS $$
DECLARE
  v_row messages%ROWTYPE;
  v_seq BIGINT;
BEGIN
  -- Fast-path: idempotent replay
  SELECT * INTO v_row
  FROM messages m
  WHERE m.sender_id = p_sender_id AND m.client_msg_id = p_client_msg_id;

  IF FOUND THEN
    id              := v_row.id;
    conversation_id := v_row.conversation_id;
    sender_id       := v_row.sender_id;
    client_msg_id   := v_row.client_msg_id;
    seq             := v_row.seq;
    type            := v_row.type;
    content         := v_row.content;
    metadata        := v_row.metadata;
    created_at      := v_row.created_at;
    is_replay       := TRUE;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Allocate seq + insert + fan-out deliveries inside a subtransaction so we
  -- can recover from the concurrent-write race (two calls trying to insert
  -- the same client_msg_id).
  BEGIN
    UPDATE conversations c
    SET next_seq = c.next_seq + 1,
        last_message_at = NOW()
    WHERE c.id = p_conversation_id
    RETURNING c.next_seq - 1 INTO v_seq;

    IF v_seq IS NULL THEN
      RAISE EXCEPTION 'Conversation % not found', p_conversation_id
        USING ERRCODE = 'no_data_found';
    END IF;

    INSERT INTO messages (
      id, conversation_id, sender_id, client_msg_id, seq,
      type, content, metadata
    ) VALUES (
      p_message_id, p_conversation_id, p_sender_id, p_client_msg_id, v_seq,
      p_type, p_content, COALESCE(p_metadata, '{}'::jsonb)
    )
    RETURNING * INTO v_row;

    -- Fan-out delivery envelopes for every non-sender participant. This lives
    -- inside the same transaction as the message insert: there is never a
    -- moment where a message row exists without its deliveries.
    INSERT INTO message_deliveries (id, message_id, recipient_agent_id)
    SELECT
      'del_' || replace(gen_random_uuid()::text, '-', ''),
      v_row.id,
      cp.agent_id
    FROM conversation_participants cp
    WHERE cp.conversation_id = p_conversation_id
      AND cp.agent_id <> p_sender_id;

    id              := v_row.id;
    conversation_id := v_row.conversation_id;
    sender_id       := v_row.sender_id;
    client_msg_id   := v_row.client_msg_id;
    seq             := v_row.seq;
    type            := v_row.type;
    content         := v_row.content;
    metadata        := v_row.metadata;
    created_at      := v_row.created_at;
    is_replay       := FALSE;
    RETURN NEXT;
    RETURN;
  EXCEPTION WHEN unique_violation THEN
    -- A concurrent call already inserted the same (sender_id, client_msg_id).
    -- Re-fetch and return as replay.
    SELECT * INTO v_row
    FROM messages m
    WHERE m.sender_id = p_sender_id AND m.client_msg_id = p_client_msg_id;

    IF NOT FOUND THEN
      -- Unique violation came from something else — surface the original.
      RAISE;
    END IF;

    id              := v_row.id;
    conversation_id := v_row.conversation_id;
    sender_id       := v_row.sender_id;
    client_msg_id   := v_row.client_msg_id;
    seq             := v_row.seq;
    type            := v_row.type;
    content         := v_row.content;
    metadata        := v_row.metadata;
    created_at      := v_row.created_at;
    is_replay       := TRUE;
    RETURN NEXT;
    RETURN;
  END;
END;
$$ LANGUAGE plpgsql;

-- 4. Drop the now-obsolete columns and index from messages -------------------

DROP INDEX IF EXISTS idx_messages_status;
ALTER TABLE messages DROP COLUMN status;
ALTER TABLE messages DROP COLUMN delivered_at;
ALTER TABLE messages DROP COLUMN read_at;

-- 5. Forward-only status trigger on message_deliveries ----------------------
--
-- Belt-and-suspenders: the application layer already guards with
-- WHERE status IN (allowed_previous), but a race between a late webhook
-- retry and a read-receipt could still attempt to downgrade 'read' to
-- 'delivered' at the DB level. This trigger silently preserves the OLD state
-- in that case instead of raising an error, so the late write is a no-op
-- rather than a 500.

CREATE OR REPLACE FUNCTION enforce_delivery_status_forward()
RETURNS TRIGGER AS $$
DECLARE
  old_rank INT;
  new_rank INT;
BEGIN
  old_rank := CASE OLD.status
    WHEN 'stored'    THEN 0
    WHEN 'delivered' THEN 1
    WHEN 'read'      THEN 2
  END;
  new_rank := CASE NEW.status
    WHEN 'stored'    THEN 0
    WHEN 'delivered' THEN 1
    WHEN 'read'      THEN 2
  END;

  IF new_rank < old_rank THEN
    NEW.status       := OLD.status;
    NEW.delivered_at := OLD.delivered_at;
    NEW.read_at      := OLD.read_at;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER message_deliveries_forward_status
  BEFORE UPDATE OF status ON message_deliveries
  FOR EACH ROW
  EXECUTE FUNCTION enforce_delivery_status_forward();
