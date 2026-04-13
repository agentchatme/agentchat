-- Migration 019: Group deletion (soft) + creator-only disband
--
-- Adds a disband path for groups. Creator-only by default; if the creator's
-- account is suspended or deleted, the earliest-joined remaining admin
-- inherits the authority (symmetric with the last-admin auto-promote in
-- leave_group_atomic).
--
-- Why soft delete:
--   - Attachments and historical messages stay queryable so abuse reports
--     that reference a deleted group still have evidence (matches the
--     hide-for-me-only invariant for messages).
--   - Former members get a 410 Gone with deleted_by / deleted_at metadata
--     instead of a blank 404 on any lingering read path, so the SDK /
--     dashboard can render "the group was deleted by @alice" instead of
--     a confusing "not found" after the fact.
--   - Hard delete would require either cascading through messages/
--     attachments (loses evidence) or a long-running background sweep.
--     Soft delete is O(1) and reversible in the unlikely case we ever
--     need to un-delete.
--
-- Invariants this migration establishes:
--   1. conversations.deleted_at marks the delete. deleted_by captures the
--      actor (an agent id, nullable only for historical rows).
--   2. The group_metadata_check CHECK is NOT relaxed — deleted groups keep
--      their name / created_by / group_settings so former-member reads
--      can render "the group was deleted by @alice" without synthesizing
--      missing fields.
--   3. delete_group_atomic runs inside a single transaction: verify
--      authority, emit the final 'group_deleted' system message via the
--      existing send_message_atomic path, set deleted_at on the
--      conversation, soft-remove ALL remaining members via left_at, flush
--      their stored deliveries, and cancel all pending invitations. Fan-out
--      of the 'group.deleted' WS / webhook event stays in application code.
--   4. Non-members that query a deleted group continue to get 404 from the
--      service layer (existence masked). Former members get 410 Gone with
--      DeletedGroupInfo metadata. The distinction is "does the caller have
--      a conversation_participants row at all".
--   5. send_message_atomic is NOT changed here — the final system message
--      is written BEFORE deleted_at is set, and the application-layer
--      gate on subsequent writes (deleted_at IS NOT NULL -> 410) is in
--      the service/route layer. A belt-and-suspenders DB-level guard
--      would add a second branch inside send_message_atomic with no real
--      correctness benefit.

-- ─── 1. Soft-delete columns on conversations ──────────────────────────────

ALTER TABLE conversations
  ADD COLUMN deleted_at TIMESTAMPTZ,
  ADD COLUMN deleted_by TEXT REFERENCES agents(id);

-- Partial index so "list my active conversations" stays fast — almost all
-- rows are deleted_at IS NULL in steady state, but the partial still helps
-- queries that filter on it (esp. the getAgentConversations path, which
-- already joins through conversation_participants).
CREATE INDEX IF NOT EXISTS idx_conversations_active
  ON conversations(id)
  WHERE deleted_at IS NULL;

-- ─── 2. delete_group_atomic ───────────────────────────────────────────────
--
-- Parameters:
--   p_group_id   — target conversation (must be type='group')
--   p_actor_id   — caller's agent id. Must be the creator, OR an active
--                  admin when the creator is suspended/deleted (inherit).
--   p_system_msg_id        — pre-generated message id for the final
--                            'group_deleted' system message
--   p_system_client_msg_id — pre-generated client_msg_id (prefixed 'sys_')
--   p_system_content       — JSONB payload matching GroupSystemEventV1
--                            {schema_version:1, event:'group_deleted', ...}
--
-- Returns (seq, deleted_at) — the seq of the final system message (so
-- the service can propagate it on the WS fan-out) and the authoritative
-- deletion timestamp.
--
-- Errors:
--   'group_not_found'        — no row for p_group_id
--   'not_a_group'            — conversation exists but type != 'group'
--   'already_deleted'        — deleted_at is already set (idempotent caller
--                              should detect and skip; we raise here so
--                              the 200-on-replay path is explicit and
--                              doesn't silently double-emit the system
--                              message)
--   'forbidden'              — caller is not the creator and the creator
--                              is still an active account (no inheritance)
--   'forbidden_not_admin'    — creator is suspended/deleted but the caller
--                              is not an active admin of the group
--
-- Everything runs under a FOR UPDATE lock on the conversation row so a
-- concurrent leave/kick/promote can't race past the authority check.

CREATE OR REPLACE FUNCTION delete_group_atomic(
  p_group_id             TEXT,
  p_actor_id             TEXT,
  p_system_msg_id        TEXT,
  p_system_client_msg_id TEXT,
  p_system_content       JSONB
) RETURNS TABLE(seq BIGINT, deleted_at TIMESTAMPTZ) AS $$
DECLARE
  v_type            TEXT;
  v_creator         TEXT;
  v_deleted_at      TIMESTAMPTZ;
  v_creator_status  TEXT;
  v_actor_role      TEXT;
  v_actor_left_at   TIMESTAMPTZ;
  v_next_seq        BIGINT;
  v_msg_seq         BIGINT;
  v_now             TIMESTAMPTZ := NOW();
BEGIN
  SELECT c.type, c.created_by, c.deleted_at, c.next_seq
    INTO v_type, v_creator, v_deleted_at, v_next_seq
  FROM conversations c
  WHERE c.id = p_group_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'group_not_found' USING ERRCODE = 'no_data_found';
  END IF;

  IF v_type <> 'group' THEN
    RAISE EXCEPTION 'not_a_group' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF v_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'already_deleted' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Authority check. Fast path: the caller IS the creator and the creator
  -- is still an active/restricted account (restricted accounts can still
  -- manage their own groups).
  IF v_creator = p_actor_id THEN
    SELECT a.status INTO v_creator_status
    FROM agents a
    WHERE a.id = p_actor_id;

    IF v_creator_status IN ('suspended', 'deleted') THEN
      -- Edge case: suspended creator tries to disband their own group.
      -- Disallow — a suspended account shouldn't take authority actions
      -- on other agents' membership. Let an inheritor do it instead.
      RAISE EXCEPTION 'forbidden' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    -- Caller is not the creator. Inheritance only fires if the creator's
    -- account is suspended or deleted.
    SELECT a.status INTO v_creator_status
    FROM agents a
    WHERE a.id = v_creator;

    IF v_creator_status IS NULL OR v_creator_status NOT IN ('suspended', 'deleted') THEN
      RAISE EXCEPTION 'forbidden' USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Inheritor must be an active admin of the group.
    SELECT cp.role, cp.left_at INTO v_actor_role, v_actor_left_at
    FROM conversation_participants cp
    WHERE cp.conversation_id = p_group_id AND cp.agent_id = p_actor_id;

    IF NOT FOUND OR v_actor_left_at IS NOT NULL OR v_actor_role <> 'admin' THEN
      RAISE EXCEPTION 'forbidden_not_admin' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  -- 1. Write the final 'group_deleted' system message INLINE (without
  --    calling send_message_atomic) so we don't double-lock the
  --    conversation row. We already hold the lock and know next_seq.
  UPDATE conversations c
  SET next_seq = c.next_seq + 1,
      last_message_at = v_now
  WHERE c.id = p_group_id
  RETURNING c.next_seq - 1 INTO v_msg_seq;

  INSERT INTO messages (
    id, conversation_id, sender_id, client_msg_id, seq,
    type, content, metadata
  ) VALUES (
    p_system_msg_id, p_group_id, p_actor_id, p_system_client_msg_id, v_msg_seq,
    'system', jsonb_build_object('data', p_system_content), '{}'::jsonb
  );

  -- Fan-out envelopes for every non-sender, still-active participant so
  -- the final message lands in their /sync drain the same way any other
  -- group message would.
  INSERT INTO message_deliveries (id, message_id, recipient_agent_id)
  SELECT
    'del_' || replace(gen_random_uuid()::text, '-', ''),
    p_system_msg_id,
    cp.agent_id
  FROM conversation_participants cp
  WHERE cp.conversation_id = p_group_id
    AND cp.agent_id <> p_actor_id
    AND cp.left_at IS NULL;

  -- 2. Mark the conversation deleted.
  UPDATE conversations c
  SET deleted_at = v_now,
      deleted_by = p_actor_id
  WHERE c.id = p_group_id;

  -- 3. Soft-remove every remaining active member so their /v1/conversations
  --    list drops the group, their group role checks fail cleanly, and the
  --    sync drain doesn't keep returning new messages. The final system
  --    message above was already fanned out to them, so it shows up on
  --    their next /sync and they can render "the group was deleted by
  --    @alice" from that row alone.
  UPDATE conversation_participants cp
  SET left_at = v_now
  WHERE cp.conversation_id = p_group_id
    AND cp.left_at IS NULL;

  -- 4. Flush stored envelopes for every (former) member of THIS
  --    conversation to 'delivered'. Matches leave/kick semantics — the
  --    /sync drain stops returning messages for a conversation you no
  --    longer see. The final 'group_deleted' envelope we just inserted is
  --    still at 'stored', so it will come through on the next /sync and
  --    THEN get flushed by the normal ack path.
  UPDATE message_deliveries md
  SET status = 'delivered',
      delivered_at = v_now
  FROM messages m
  WHERE md.message_id = m.id
    AND m.conversation_id = p_group_id
    AND md.status = 'stored'
    AND md.message_id <> p_system_msg_id;

  -- 5. Cancel every pending invite to this group — there's no group to
  --    join anymore. Recipients will see the invite disappear from their
  --    /v1/groups/invites list on next fetch; no separate notification is
  --    emitted for this (the 'group.deleted' event covers members, and
  --    never-joined invitees don't need a ping about a group they never
  --    actually saw the inside of).
  DELETE FROM group_invitations
  WHERE conversation_id = p_group_id;

  seq := v_msg_seq;
  deleted_at := v_now;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql;
