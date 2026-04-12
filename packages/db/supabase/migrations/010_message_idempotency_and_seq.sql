-- Migration 010: Message idempotency + per-conversation monotonic sequence
--
-- Two durability/ordering guarantees that were missing from the message model:
--
-- 1. client_msg_id — sender-provided idempotency key. A network retry after a
--    successful 201 used to create a duplicate message. Now the same
--    (sender_id, client_msg_id) returns the existing row (is_replay = TRUE).
--    UNIQUE(sender_id, client_msg_id) enforces this at the DB level.
--
-- 2. seq — per-conversation monotonic BIGINT assigned at insert time.
--    Replaces created_at as the canonical ordering key: two writes in the same
--    millisecond no longer collide, and sync/pagination cursors become
--    gap-free integers. The counter lives on conversations.next_seq and is
--    atomically bumped inside send_message_atomic().
--
-- A SQL-level function send_message_atomic() is the single write path for
-- messages. It handles the idempotency fast-path, the seq allocation, and the
-- race where two concurrent transactions insert with the same client_msg_id
-- (unique_violation → return replay). Application code calls this RPC instead
-- of a plain INSERT.

-- 1. client_msg_id column + unique index
ALTER TABLE messages ADD COLUMN client_msg_id TEXT;

-- Backfill legacy rows with their own id so every row has a stable idempotency
-- key. Uniqueness is per sender, so reusing the message id is safe.
UPDATE messages SET client_msg_id = id WHERE client_msg_id IS NULL;

ALTER TABLE messages ALTER COLUMN client_msg_id SET NOT NULL;

CREATE UNIQUE INDEX messages_sender_client_msg_id_unique
  ON messages(sender_id, client_msg_id);

-- 2. seq column on messages + next_seq cursor on conversations
ALTER TABLE conversations ADD COLUMN next_seq BIGINT NOT NULL DEFAULT 1;

ALTER TABLE messages ADD COLUMN seq BIGINT;

-- Backfill seq in created_at order per conversation
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY conversation_id
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM messages
)
UPDATE messages m
SET seq = r.rn
FROM ranked r
WHERE m.id = r.id;

-- Set each conversation's next_seq to MAX(seq)+1 so new writes continue from
-- the correct position. Conversations with no messages keep next_seq=1.
UPDATE conversations c
SET next_seq = COALESCE(sub.max_seq, 0) + 1
FROM (
  SELECT conversation_id, MAX(seq) AS max_seq
  FROM messages
  GROUP BY conversation_id
) sub
WHERE c.id = sub.conversation_id;

ALTER TABLE messages ALTER COLUMN seq SET NOT NULL;

CREATE UNIQUE INDEX messages_conv_seq_unique
  ON messages(conversation_id, seq);

-- Ordered read index for history pagination (DESC matches the common pattern
-- "latest first, scroll back"). The existing idx_messages_conv by created_at
-- is kept for now so legacy queries don't regress during the rollout.
CREATE INDEX idx_messages_conv_seq_desc
  ON messages(conversation_id, seq DESC);

-- 3. Atomic send function
-- Handles: idempotency fast-path, atomic seq allocation, insert, and the
-- concurrent-write race via a unique_violation recovery.
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
  status          TEXT,
  created_at      TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  read_at         TIMESTAMPTZ,
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
    status          := v_row.status;
    created_at      := v_row.created_at;
    delivered_at    := v_row.delivered_at;
    read_at         := v_row.read_at;
    is_replay       := TRUE;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Allocate seq + insert inside a subtransaction so we can recover from the
  -- concurrent-write race (two calls inserting the same client_msg_id).
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
      type, content, metadata, status
    ) VALUES (
      p_message_id, p_conversation_id, p_sender_id, p_client_msg_id, v_seq,
      p_type, p_content, COALESCE(p_metadata, '{}'::jsonb), 'stored'
    )
    RETURNING * INTO v_row;

    id              := v_row.id;
    conversation_id := v_row.conversation_id;
    sender_id       := v_row.sender_id;
    client_msg_id   := v_row.client_msg_id;
    seq             := v_row.seq;
    type            := v_row.type;
    content         := v_row.content;
    metadata        := v_row.metadata;
    status          := v_row.status;
    created_at      := v_row.created_at;
    delivered_at    := v_row.delivered_at;
    read_at         := v_row.read_at;
    is_replay       := FALSE;
    RETURN NEXT;
    RETURN;
  EXCEPTION WHEN unique_violation THEN
    -- Another concurrent call inserted the same (sender_id, client_msg_id).
    -- Re-fetch and return as replay.
    SELECT * INTO v_row
    FROM messages m
    WHERE m.sender_id = p_sender_id AND m.client_msg_id = p_client_msg_id;

    IF NOT FOUND THEN
      -- Unique violation came from something else (e.g. messages.id clash on
      -- a client-supplied id); surface the original error.
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
    status          := v_row.status;
    created_at      := v_row.created_at;
    delivered_at    := v_row.delivered_at;
    read_at         := v_row.read_at;
    is_replay       := TRUE;
    RETURN NEXT;
    RETURN;
  END;
END;
$$ LANGUAGE plpgsql;
