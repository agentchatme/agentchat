-- Migration 025: Bounded recipient queue (§3.4.2)
--
-- An offline agent accumulating `message_deliveries` rows forever would
-- eventually dominate the table, slow everyone else's queries, and create
-- a thundering-herd sync the moment they reconnect. This migration installs
-- a flat per-recipient cap of 10_000 undelivered envelopes.
--
-- Design:
--
--   1. A single integer column `agents.undelivered_count` tracks the current
--      count of 'stored' envelopes for each agent. Kept in sync by two
--      message_deliveries triggers — one on INSERT (+1 when inserted in
--      'stored'), one on UPDATE (-1 when the status moves off 'stored').
--      Triggers run inside the same transaction as the caller, so the
--      counter always moves with the state it describes. Every existing and
--      future write path is covered without touching its code.
--
--   2. `send_message_atomic` is rewritten to consult the counter before
--      inserting the envelope:
--
--        - Direct: read the single recipient's counter under FOR NO KEY
--          UPDATE. If >= cap, raise `recipient_backlogged` with the
--          recipient id. The service layer catches and returns HTTP 429
--          `RECIPIENT_BACKLOGGED` to the sender. Nothing persists — the
--          seq bump and message insert are skipped because the raise
--          happens before them.
--
--        - Group: lock every candidate agent row, partition into eligible
--          (< cap) and skipped (>= cap). Insert envelopes only for
--          eligible members. Return the skipped ids so the service layer
--          can report them on the 201 response — the message itself
--          still lands, because one backlogged member shouldn't block a
--          group broadcast.
--
--   3. A daily reconciliation query (referenced in §9.3) compares
--      `agents.undelivered_count` against
--      `COUNT(*) FROM message_deliveries WHERE status='stored' GROUP BY
--      recipient_agent_id`. Should always match; drift means a code path
--      touched an envelope without touching the counter — investigate and
--      correct.

-- ─── 1. Counter column ─────────────────────────────────────────────────────

ALTER TABLE agents
  ADD COLUMN undelivered_count INT NOT NULL DEFAULT 0
    CHECK (undelivered_count >= 0);

-- ─── 2. Backfill from existing envelopes ───────────────────────────────────

UPDATE agents a
SET undelivered_count = sub.c
FROM (
  SELECT recipient_agent_id, COUNT(*)::INT AS c
  FROM message_deliveries
  WHERE status = 'stored'
  GROUP BY recipient_agent_id
) sub
WHERE a.id = sub.recipient_agent_id;

-- ─── 3. Auto-increment on envelope insert ─────────────────────────────────

CREATE OR REPLACE FUNCTION bump_undelivered_on_insert()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'stored' THEN
    UPDATE agents
    SET undelivered_count = undelivered_count + 1
    WHERE id = NEW.recipient_agent_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER message_deliveries_bump_undelivered_insert
  AFTER INSERT ON message_deliveries
  FOR EACH ROW
  EXECUTE FUNCTION bump_undelivered_on_insert();

-- ─── 4. Auto-decrement on status transition off 'stored' ──────────────────
--
-- Fires AFTER UPDATE so it observes the post-BEFORE-trigger value of NEW.
-- The forward-only BEFORE trigger (migration 011) silently rewrites
-- NEW.status back to OLD.status on a downgrade attempt, so this trigger
-- correctly sees NEW.status = OLD.status in that case and no-ops.

CREATE OR REPLACE FUNCTION drop_undelivered_on_transition()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'stored' AND NEW.status <> 'stored' THEN
    UPDATE agents
    SET undelivered_count = undelivered_count - 1
    WHERE id = NEW.recipient_agent_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER message_deliveries_drop_undelivered_update
  AFTER UPDATE OF status ON message_deliveries
  FOR EACH ROW
  EXECUTE FUNCTION drop_undelivered_on_transition();

-- ─── 5. Rewrite send_message_atomic with cap enforcement ──────────────────

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
  id                    TEXT,
  conversation_id       TEXT,
  sender_id             TEXT,
  client_msg_id         TEXT,
  seq                   BIGINT,
  type                  TEXT,
  content               JSONB,
  metadata              JSONB,
  created_at            TIMESTAMPTZ,
  is_replay             BOOLEAN,
  skipped_recipient_ids TEXT[]
) AS $$
DECLARE
  v_row        messages%ROWTYPE;
  v_seq        BIGINT;
  v_deleted_at TIMESTAMPTZ;
  v_conv_type  TEXT;
  v_cap        CONSTANT INT := 10000;
  v_skipped    TEXT[] := ARRAY[]::TEXT[];
  v_sole_recip TEXT;
  v_sole_count INT;
BEGIN
  -- Idempotent replay fast-path. The deleted_at guard is intentionally
  -- SKIPPED here: replaying a previously-successful send must return the
  -- same answer regardless of the conversation's current state, or retries
  -- across a delete race would surface as spurious 410s to clients that
  -- already hold the message. The skipped list is empty on replay — clients
  -- should have already acted on the skip from the original response.
  SELECT * INTO v_row
  FROM messages m
  WHERE m.sender_id = p_sender_id AND m.client_msg_id = p_client_msg_id;

  IF FOUND THEN
    id                    := v_row.id;
    conversation_id       := v_row.conversation_id;
    sender_id             := v_row.sender_id;
    client_msg_id         := v_row.client_msg_id;
    seq                   := v_row.seq;
    type                  := v_row.type;
    content               := v_row.content;
    metadata              := v_row.metadata;
    created_at            := v_row.created_at;
    is_replay             := TRUE;
    skipped_recipient_ids := ARRAY[]::TEXT[];
    RETURN NEXT;
    RETURN;
  END IF;

  BEGIN
    -- Lock the conversation row and read deleted_at + type atomically.
    SELECT c.deleted_at, c.type INTO v_deleted_at, v_conv_type
    FROM conversations c
    WHERE c.id = p_conversation_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Conversation % not found', p_conversation_id
        USING ERRCODE = 'no_data_found';
    END IF;

    IF v_deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'group_deleted'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- Backlog enforcement happens BEFORE seq allocation or message insert.
    -- For direct sends, a backlogged recipient aborts the whole send with
    -- no side effects. For group sends, the message still lands — only the
    -- envelope fan-out skips the backlogged members.
    IF v_conv_type = 'direct' THEN
      SELECT cp.agent_id INTO v_sole_recip
      FROM conversation_participants cp
      WHERE cp.conversation_id = p_conversation_id
        AND cp.agent_id <> p_sender_id
        AND cp.left_at IS NULL;

      IF v_sole_recip IS NOT NULL THEN
        SELECT a.undelivered_count INTO v_sole_count
        FROM agents a
        WHERE a.id = v_sole_recip
        FOR NO KEY UPDATE;

        IF v_sole_count >= v_cap THEN
          RAISE EXCEPTION 'recipient_backlogged: %', v_sole_recip
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    ELSE
      -- Group: collect backlogged members first, then lock the eligible
      -- agents so concurrent sends can't slip past the cap check on them.
      -- The PERFORM discards rows — only the FOR NO KEY UPDATE locks matter.
      SELECT COALESCE(array_agg(cp.agent_id), ARRAY[]::TEXT[]) INTO v_skipped
      FROM conversation_participants cp
      JOIN agents a ON a.id = cp.agent_id
      WHERE cp.conversation_id = p_conversation_id
        AND cp.agent_id <> p_sender_id
        AND cp.left_at IS NULL
        AND a.undelivered_count >= v_cap;

      PERFORM a.id
      FROM conversation_participants cp
      JOIN agents a ON a.id = cp.agent_id
      WHERE cp.conversation_id = p_conversation_id
        AND cp.agent_id <> p_sender_id
        AND cp.left_at IS NULL
        AND a.undelivered_count < v_cap
      FOR NO KEY UPDATE OF a;
    END IF;

    UPDATE conversations c
    SET next_seq = c.next_seq + 1,
        last_message_at = NOW()
    WHERE c.id = p_conversation_id
    RETURNING c.next_seq - 1 INTO v_seq;

    INSERT INTO messages (
      id, conversation_id, sender_id, client_msg_id, seq,
      type, content, metadata
    ) VALUES (
      p_message_id, p_conversation_id, p_sender_id, p_client_msg_id, v_seq,
      p_type, p_content, COALESCE(p_metadata, '{}'::jsonb)
    )
    RETURNING * INTO v_row;

    -- Envelope fan-out: skip backlogged members (empty for direct sends,
    -- populated for groups). The INSERT trigger auto-increments each
    -- eligible recipient's undelivered_count.
    INSERT INTO message_deliveries (id, message_id, recipient_agent_id)
    SELECT
      'del_' || replace(gen_random_uuid()::text, '-', ''),
      v_row.id,
      cp.agent_id
    FROM conversation_participants cp
    WHERE cp.conversation_id = p_conversation_id
      AND cp.agent_id <> p_sender_id
      AND cp.left_at IS NULL
      AND cp.agent_id <> ALL(v_skipped);

    id                    := v_row.id;
    conversation_id       := v_row.conversation_id;
    sender_id             := v_row.sender_id;
    client_msg_id         := v_row.client_msg_id;
    seq                   := v_row.seq;
    type                  := v_row.type;
    content               := v_row.content;
    metadata              := v_row.metadata;
    created_at            := v_row.created_at;
    is_replay             := FALSE;
    skipped_recipient_ids := v_skipped;
    RETURN NEXT;
    RETURN;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_row
    FROM messages m
    WHERE m.sender_id = p_sender_id AND m.client_msg_id = p_client_msg_id;

    IF NOT FOUND THEN
      RAISE;
    END IF;

    id                    := v_row.id;
    conversation_id       := v_row.conversation_id;
    sender_id             := v_row.sender_id;
    client_msg_id         := v_row.client_msg_id;
    seq                   := v_row.seq;
    type                  := v_row.type;
    content               := v_row.content;
    metadata              := v_row.metadata;
    created_at            := v_row.created_at;
    is_replay             := TRUE;
    skipped_recipient_ids := ARRAY[]::TEXT[];
    RETURN NEXT;
    RETURN;
  END;
END;
$$ LANGUAGE plpgsql;
