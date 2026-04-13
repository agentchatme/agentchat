-- Migration 020: deleted_at guards on group atomic RPCs
--
-- Closes a TOCTOU race window between delete_group_atomic and the other
-- group mutation RPCs. Migration 019 deliberately skipped the DB-level
-- guard on send_message_atomic, arguing the application-layer gate was
-- sufficient. The deep audit after 019 shipped surfaced the subtle bug
-- in that reasoning: the service-layer deleted_at check happens in a
-- separate MVCC snapshot from the RPC's FOR UPDATE lock. A concurrent
-- delete can commit in the gap between the service read and the RPC's
-- lock acquisition, leaving the RPC running against a deleted
-- conversation without noticing.
--
-- Damage from the race before this fix:
--   - send_message_atomic: inserts a message with zero delivery envelopes
--     (fan-out filters `left_at IS NULL`, which post-delete excludes
--     everyone). Sender receives a misleading 201.
--   - add_member_atomic: INSERTs a fresh participant row into a deleted
--     group. The new member sees the ghost group in
--     getAgentConversations until they open it and hit 410.
--   - accept_invite_atomic: same shape, via add_member_atomic.
--   - kick / leave / promote / demote: no-op today (every participant
--     row has left_at != NULL so the WHERE filters produce zero updates),
--     which translates to a slightly misleading 404 instead of a 410.
--
-- Fix: add `v_deleted_at IS NOT NULL` guard immediately after each
-- FOR UPDATE in every group-mutating RPC. On hit, RAISE a named
-- 'group_deleted' exception. The service layer catches the text match
-- and translates to a GroupError/MessageError with code 'GROUP_DELETED'
-- and status 410, attaching fresh DeletedGroupInfo from a re-fetch.
--
-- delete_group_atomic is unchanged — it writes the final 'group_deleted'
-- system message via inline SQL (not through send_message_atomic) and
-- already raises 'already_deleted' on replay.
--
-- Direct conversations are unaffected: deleted_at is only ever set on
-- type='group' rows (delete_group_atomic raises 'not_a_group' on
-- anything else), so the new guard is always a no-op for directs.

-- ─── 1. send_message_atomic ────────────────────────────────────────────────

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
  v_row        messages%ROWTYPE;
  v_seq        BIGINT;
  v_deleted_at TIMESTAMPTZ;
BEGIN
  -- Idempotent replay fast-path. The deleted_at guard is intentionally
  -- SKIPPED here: replaying a previously-successful send must return
  -- the same answer regardless of the conversation's current state, or
  -- retries across a delete race would surface as spurious 410s to
  -- clients that already hold the message.
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

  BEGIN
    -- Lock the conversation row and check deleted_at atomically. The
    -- FOR UPDATE here serializes us against delete_group_atomic: once
    -- we hold the lock, any concurrent delete has either not started
    -- or has already committed — and we see the committed deleted_at.
    SELECT c.deleted_at INTO v_deleted_at
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
      AND cp.left_at IS NULL;

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
    SELECT * INTO v_row
    FROM messages m
    WHERE m.sender_id = p_sender_id AND m.client_msg_id = p_client_msg_id;

    IF NOT FOUND THEN
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

-- ─── 2. add_member_atomic ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION add_member_atomic(
  p_group_id  TEXT,
  p_agent_id  TEXT,
  p_max_size  INTEGER
) RETURNS TABLE(status TEXT, joined_seq BIGINT) AS $$
DECLARE
  v_next_seq   BIGINT;
  v_type       TEXT;
  v_deleted_at TIMESTAMPTZ;
  v_count      INTEGER;
  v_existing   conversation_participants%ROWTYPE;
BEGIN
  SELECT c.next_seq, c.type, c.deleted_at
    INTO v_next_seq, v_type, v_deleted_at
  FROM conversations c
  WHERE c.id = p_group_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Group % not found', p_group_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_type <> 'group' THEN
    RAISE EXCEPTION 'Conversation % is not a group', p_group_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF v_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'group_deleted'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT COUNT(*)::INTEGER INTO v_count
  FROM conversation_participants cp
  WHERE cp.conversation_id = p_group_id
    AND cp.left_at IS NULL;

  IF v_count >= p_max_size THEN
    RAISE EXCEPTION 'Group % is at max capacity (%)', p_group_id, p_max_size
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_existing
  FROM conversation_participants cp
  WHERE cp.conversation_id = p_group_id AND cp.agent_id = p_agent_id;

  IF FOUND AND v_existing.left_at IS NULL THEN
    status := 'already_member';
    joined_seq := v_existing.joined_seq;
    RETURN NEXT;
    RETURN;
  END IF;

  IF FOUND THEN
    UPDATE conversation_participants
    SET left_at    = NULL,
        joined_at  = NOW(),
        joined_seq = v_next_seq,
        role       = 'member'
    WHERE conversation_id = p_group_id AND agent_id = p_agent_id;
    status := 'rejoined';
  ELSE
    INSERT INTO conversation_participants (
      conversation_id, agent_id, role, joined_at, joined_seq, left_at
    ) VALUES (
      p_group_id, p_agent_id, 'member', NOW(), v_next_seq, NULL
    );
    status := 'joined';
  END IF;

  joined_seq := v_next_seq;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql;

-- ─── 3. leave_group_atomic ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION leave_group_atomic(
  p_group_id TEXT,
  p_agent_id TEXT
) RETURNS TABLE(was_member BOOLEAN, promoted_agent_id TEXT) AS $$
DECLARE
  v_row         conversation_participants%ROWTYPE;
  v_deleted_at  TIMESTAMPTZ;
  v_admin_count INTEGER;
  v_promoted    TEXT;
BEGIN
  SELECT c.deleted_at INTO v_deleted_at
  FROM conversations c
  WHERE c.id = p_group_id
  FOR UPDATE;

  IF NOT FOUND THEN
    was_member := FALSE;
    promoted_agent_id := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'group_deleted'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO v_row
  FROM conversation_participants cp
  WHERE cp.conversation_id = p_group_id
    AND cp.agent_id = p_agent_id
    AND cp.left_at IS NULL;

  IF NOT FOUND THEN
    was_member := FALSE;
    promoted_agent_id := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  UPDATE conversation_participants
  SET left_at = NOW()
  WHERE conversation_id = p_group_id AND agent_id = p_agent_id;

  UPDATE message_deliveries md
  SET status = 'delivered',
      delivered_at = NOW()
  FROM messages m
  WHERE md.message_id = m.id
    AND m.conversation_id = p_group_id
    AND md.recipient_agent_id = p_agent_id
    AND md.status = 'stored';

  IF v_row.role = 'admin' THEN
    SELECT COUNT(*)::INTEGER INTO v_admin_count
    FROM conversation_participants cp
    WHERE cp.conversation_id = p_group_id
      AND cp.role = 'admin'
      AND cp.left_at IS NULL;

    IF v_admin_count = 0 THEN
      SELECT cp.agent_id INTO v_promoted
      FROM conversation_participants cp
      WHERE cp.conversation_id = p_group_id
        AND cp.left_at IS NULL
      ORDER BY cp.joined_at ASC, cp.agent_id ASC
      LIMIT 1;

      IF v_promoted IS NOT NULL THEN
        UPDATE conversation_participants
        SET role = 'admin'
        WHERE conversation_id = p_group_id AND agent_id = v_promoted;
      END IF;
    END IF;
  END IF;

  was_member := TRUE;
  promoted_agent_id := v_promoted;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql;

-- ─── 4. kick_member_atomic ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION kick_member_atomic(
  p_group_id  TEXT,
  p_target_id TEXT
) RETURNS TABLE(was_member BOOLEAN) AS $$
DECLARE
  v_creator    TEXT;
  v_deleted_at TIMESTAMPTZ;
  v_found      BOOLEAN;
BEGIN
  SELECT c.created_by, c.deleted_at
    INTO v_creator, v_deleted_at
  FROM conversations c
  WHERE c.id = p_group_id
  FOR UPDATE;

  IF NOT FOUND THEN
    was_member := FALSE;
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'group_deleted'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF v_creator = p_target_id THEN
    RAISE EXCEPTION 'Cannot kick the group creator'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE conversation_participants
  SET left_at = NOW()
  WHERE conversation_id = p_group_id
    AND agent_id = p_target_id
    AND left_at IS NULL
  RETURNING TRUE INTO v_found;

  IF NOT FOUND THEN
    was_member := FALSE;
    RETURN NEXT;
    RETURN;
  END IF;

  UPDATE message_deliveries md
  SET status = 'delivered',
      delivered_at = NOW()
  FROM messages m
  WHERE md.message_id = m.id
    AND m.conversation_id = p_group_id
    AND md.recipient_agent_id = p_target_id
    AND md.status = 'stored';

  was_member := TRUE;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql;

-- ─── 5. promote_to_admin_atomic ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION promote_to_admin_atomic(
  p_group_id  TEXT,
  p_target_id TEXT
) RETURNS BOOLEAN AS $$
DECLARE
  v_updated    INTEGER;
  v_deleted_at TIMESTAMPTZ;
BEGIN
  SELECT c.deleted_at INTO v_deleted_at
  FROM conversations c
  WHERE c.id = p_group_id
  FOR UPDATE;

  IF NOT FOUND THEN RETURN FALSE; END IF;

  IF v_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'group_deleted'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE conversation_participants
  SET role = 'admin'
  WHERE conversation_id = p_group_id
    AND agent_id = p_target_id
    AND left_at IS NULL
    AND role = 'member';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$ LANGUAGE plpgsql;

-- ─── 6. demote_admin_atomic ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION demote_admin_atomic(
  p_group_id  TEXT,
  p_target_id TEXT
) RETURNS TEXT AS $$
DECLARE
  v_creator     TEXT;
  v_deleted_at  TIMESTAMPTZ;
  v_role        TEXT;
  v_left_at     TIMESTAMPTZ;
  v_admin_count INTEGER;
BEGIN
  SELECT c.created_by, c.deleted_at
    INTO v_creator, v_deleted_at
  FROM conversations c
  WHERE c.id = p_group_id
  FOR UPDATE;

  IF NOT FOUND THEN RETURN 'not_found'; END IF;

  IF v_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'group_deleted'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF v_creator = p_target_id THEN RETURN 'creator'; END IF;

  SELECT role, left_at INTO v_role, v_left_at
  FROM conversation_participants
  WHERE conversation_id = p_group_id AND agent_id = p_target_id;

  IF NOT FOUND OR v_left_at IS NOT NULL THEN RETURN 'not_found'; END IF;
  IF v_role <> 'admin' THEN RETURN 'not_admin'; END IF;

  SELECT COUNT(*)::INTEGER INTO v_admin_count
  FROM conversation_participants cp
  WHERE cp.conversation_id = p_group_id
    AND cp.role = 'admin'
    AND cp.left_at IS NULL;

  IF v_admin_count <= 1 THEN RETURN 'last_admin'; END IF;

  UPDATE conversation_participants
  SET role = 'member'
  WHERE conversation_id = p_group_id AND agent_id = p_target_id;

  RETURN 'ok';
END;
$$ LANGUAGE plpgsql;
