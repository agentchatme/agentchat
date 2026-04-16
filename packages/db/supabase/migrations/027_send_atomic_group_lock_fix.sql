-- Migration 027: Fix race in send_message_atomic group-send backlog check.
--
-- Migration 025 computed `v_skipped` from an UNLOCKED read, then locked
-- the eligible set under FOR NO KEY UPDATE in a separate statement. A
-- concurrent sender targeting the same recipient via a different
-- conversation could push an agent from 9999 → 10001 between those two
-- steps, so we'd (a) miss them in v_skipped and (b) fan out an envelope
-- for them anyway, leaving the counter slightly above the flat 10k cap.
--
-- Fix: lock every candidate agent row in ONE query and partition the
-- locked snapshot in plpgsql. Agents held under FOR NO KEY UPDATE by a
-- concurrent sender serialize into us — by the time our loop sees them
-- they reflect the committed counter, so skipped vs eligible is decided
-- against the same truth we hand to the INSERT fan-out.
--
-- Direct-send path is unchanged — it already locks the sole recipient
-- under FOR NO KEY UPDATE and uses the locked read for the check.

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
  v_rec        RECORD;
BEGIN
  -- Idempotent replay fast-path.
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
      -- Group: lock every non-sender active recipient in ONE query, then
      -- partition the locked snapshot. Reading undelivered_count under
      -- the same lock that holds through the subsequent INSERT guarantees
      -- skipped vs eligible matches the state the fan-out writes against.
      FOR v_rec IN
        SELECT a.id AS agent_id, a.undelivered_count
        FROM conversation_participants cp
        JOIN agents a ON a.id = cp.agent_id
        WHERE cp.conversation_id = p_conversation_id
          AND cp.agent_id <> p_sender_id
          AND cp.left_at IS NULL
        FOR NO KEY UPDATE OF a
      LOOP
        IF v_rec.undelivered_count >= v_cap THEN
          v_skipped := array_append(v_skipped, v_rec.agent_id);
        END IF;
      END LOOP;
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
