-- Migration 017: Group conversations
--
-- The conversation + participant schema already reserved `type='group'` and
-- `role IN ('admin','member','read_only')` on day 1, so most of the wiring
-- is additive: group metadata onto conversations, soft-remove on
-- participants, an invitations table for non-contact consent, and a handful
-- of atomic RPCs to keep membership transitions race-free.
--
-- Invariants this migration establishes:
--   1. Direct conversations have no name/description/created_by; groups must
--      have name and created_by. Enforced by a CHECK constraint so a stray
--      INSERT can't produce an orphan group.
--   2. Members are never hard-deleted: `left_at` flags a soft-remove.
--      Historical messages keep their sender reference, and re-joining is an
--      UPDATE of the existing row, not a PK collision.
--   3. Every membership mutation runs inside a plpgsql RPC that takes a row
--      lock on the conversation, so concurrent leave/kick/demote/promote
--      calls can't race past the "last admin" safeguard or the 100-member
--      cap.
--   4. Joining snapshots `joined_seq` from `conversations.next_seq` under
--      the same lock, so new members' history filter (`seq >= joined_seq`)
--      starts at the moment they joined — no pre-join leakage.
--   5. On leave/kick, the departing agent's `stored` delivery envelopes for
--      this conversation are flushed to `delivered` so the sync drain path
--      stops returning messages they should no longer see. Envelopes from
--      other conversations are untouched.
--   6. `send_message_atomic` fan-out now skips participants with
--      `left_at IS NOT NULL` so departed members stop receiving new
--      deliveries.
--   7. The `read_only` role is dropped from the CHECK constraint — it was
--      reserved but never used, and groups are admin/member only.
--   8. Enforcement (count_initiated_blocks/reports) already filters
--      `c.type = 'direct'`, so group activity has zero effect on
--      auto-restrict/auto-suspend by construction. Unchanged here.

-- ─── 1. Group metadata columns on conversations ───────────────────────────

ALTER TABLE conversations
  ADD COLUMN name           TEXT,
  ADD COLUMN description    TEXT,
  ADD COLUMN avatar_url     TEXT,
  ADD COLUMN created_by     TEXT REFERENCES agents(id),
  ADD COLUMN group_settings JSONB NOT NULL DEFAULT '{"who_can_invite":"admin"}';

-- Enforce the direct/group dichotomy at the DB level. Direct conversations
-- continue to have NULL name/created_by; groups must have both. No stray
-- state is reachable via raw INSERT.
ALTER TABLE conversations
  ADD CONSTRAINT group_metadata_check CHECK (
    (type = 'direct' AND name IS NULL AND created_by IS NULL)
    OR (type = 'group' AND name IS NOT NULL AND created_by IS NOT NULL)
  );

-- ─── 2. Soft-remove + history cutoff on conversation_participants ─────────

ALTER TABLE conversation_participants
  ADD COLUMN left_at    TIMESTAMPTZ,
  ADD COLUMN joined_seq BIGINT NOT NULL DEFAULT 1;

-- Drop the unused 'read_only' role and lock the set to admin/member.
ALTER TABLE conversation_participants
  DROP CONSTRAINT IF EXISTS conversation_participants_role_check;
ALTER TABLE conversation_participants
  ADD CONSTRAINT conversation_participants_role_check
    CHECK (role IN ('admin', 'member'));

-- Partial index to make "list my active participations" and the 100-member
-- cap count cheap. The vast majority of rows are active; this still helps
-- because it skips the increasingly long tail of `left_at IS NOT NULL`.
CREATE INDEX IF NOT EXISTS idx_cp_active
  ON conversation_participants(conversation_id, agent_id)
  WHERE left_at IS NULL;

-- ─── 3. group_invitations table ───────────────────────────────────────────

CREATE TABLE group_invitations (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  invitee_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  inviter_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (conversation_id, invitee_id)
);

-- Drain lookup: "give me my pending invites, oldest first".
CREATE INDEX idx_gi_invitee
  ON group_invitations(invitee_id, created_at ASC);

-- ─── 4. Rewrite send_message_atomic to skip departed members ──────────────
--
-- The only change from migration 011 is `AND cp.left_at IS NULL` on the
-- fan-out INSERT. Everything else — idempotency fast-path, seq allocation,
-- unique_violation recovery — is identical.

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

    -- Fan-out envelopes for every non-sender, non-departed participant.
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

-- ─── 5. create_group_atomic ───────────────────────────────────────────────
--
-- Creates a group conversation with the creator as its sole admin member,
-- snapshotting the initial joined_seq (which is always 1 for a fresh
-- conversation). Returns the new conversation id. The caller's
-- group.service then adds additional initial members by calling
-- add_member_atomic per-member, so per-member policy decisions
-- (auto-add vs pending invite) stay in application code.

CREATE OR REPLACE FUNCTION create_group_atomic(
  p_group_id    TEXT,
  p_creator_id  TEXT,
  p_name        TEXT,
  p_description TEXT,
  p_avatar_url  TEXT,
  p_settings    JSONB
) RETURNS TEXT AS $$
BEGIN
  INSERT INTO conversations (
    id, type, name, description, avatar_url, created_by, group_settings, next_seq
  ) VALUES (
    p_group_id, 'group', p_name, p_description, p_avatar_url, p_creator_id,
    COALESCE(p_settings, '{"who_can_invite":"admin"}'::jsonb), 1
  );

  INSERT INTO conversation_participants (
    conversation_id, agent_id, role, joined_at, joined_seq, left_at
  ) VALUES (
    p_group_id, p_creator_id, 'admin', NOW(), 1, NULL
  );

  RETURN p_group_id;
END;
$$ LANGUAGE plpgsql;

-- ─── 6. add_member_atomic ──────────────────────────────────────────────────
--
-- Adds an agent to an existing group (direct-add path or accept-invite
-- path). Handles the re-join case by UPDATE-ing the existing participant
-- row instead of INSERT-ing a new one (PK is (conversation_id, agent_id)).
--
-- Locks the conversation row with FOR UPDATE so the 100-member cap check
-- is race-free against concurrent adds. Snapshots joined_seq from
-- conversations.next_seq while the row is locked, so the joining member's
-- history filter starts at "right now" even if other senders are mid-write.
--
-- Returns an enum-ish text status so the caller can emit the right system
-- message ('joined' on fresh add, 'rejoined' on re-add, 'already_member' if
-- the row was already active) and a joined_seq for the caller's bookkeeping.

CREATE OR REPLACE FUNCTION add_member_atomic(
  p_group_id  TEXT,
  p_agent_id  TEXT,
  p_max_size  INTEGER
) RETURNS TABLE(status TEXT, joined_seq BIGINT) AS $$
DECLARE
  v_next_seq  BIGINT;
  v_type      TEXT;
  v_count     INTEGER;
  v_existing  conversation_participants%ROWTYPE;
BEGIN
  SELECT c.next_seq, c.type INTO v_next_seq, v_type
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

  -- Cap check runs under the row lock so we can't admit member 101.
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
    -- Re-join: reuse the row, reset joined_at/joined_seq/left_at, force
    -- role back to 'member' (previously departed admins don't inherit
    -- admin on re-join — the admin re-grant is an explicit action).
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

-- ─── 7. accept_invite_atomic ──────────────────────────────────────────────
--
-- Atomically: verify the invite belongs to the caller, add them via
-- add_member_atomic, delete the invite. One transaction so a concurrent
-- reject/expire can't race with accept.

CREATE OR REPLACE FUNCTION accept_invite_atomic(
  p_invite_id TEXT,
  p_agent_id  TEXT,
  p_max_size  INTEGER
) RETURNS TABLE(conversation_id TEXT, status TEXT, joined_seq BIGINT) AS $$
DECLARE
  v_invite group_invitations%ROWTYPE;
  v_result RECORD;
BEGIN
  SELECT * INTO v_invite
  FROM group_invitations
  WHERE id = p_invite_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invite % not found', p_invite_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_invite.invitee_id <> p_agent_id THEN
    RAISE EXCEPTION 'Invite % does not belong to caller', p_invite_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_result
  FROM add_member_atomic(v_invite.conversation_id, p_agent_id, p_max_size);

  DELETE FROM group_invitations WHERE id = p_invite_id;

  conversation_id := v_invite.conversation_id;
  status          := v_result.status;
  joined_seq      := v_result.joined_seq;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql;

-- ─── 8. leave_group_atomic ────────────────────────────────────────────────
--
-- Soft-removes the caller, flushes their still-stored envelopes for this
-- conversation to 'delivered' so the sync drain stops returning them, and
-- if they were the last remaining admin promotes the earliest-joined
-- remaining member to admin so the group is never adminless while it has
-- members.
--
-- Returns:
--   - was_member       TRUE iff the caller was active in the group
--   - promoted_agent   handle of the auto-promoted member, or NULL
--
-- The caller's group.service emits the "member_left" system message AFTER
-- this RPC (and optionally an "admin_granted" message if promoted_agent is
-- non-null). System messages are outside the transaction so the fan-out
-- push + webhook don't block the leave.

CREATE OR REPLACE FUNCTION leave_group_atomic(
  p_group_id TEXT,
  p_agent_id TEXT
) RETURNS TABLE(was_member BOOLEAN, promoted_agent_id TEXT) AS $$
DECLARE
  v_row         conversation_participants%ROWTYPE;
  v_admin_count INTEGER;
  v_promoted    TEXT;
BEGIN
  PERFORM 1 FROM conversations WHERE id = p_group_id FOR UPDATE;
  IF NOT FOUND THEN
    was_member := FALSE;
    promoted_agent_id := NULL;
    RETURN NEXT;
    RETURN;
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

  -- Flush stored envelopes for THIS conversation only. Envelopes for other
  -- conversations (directs, other groups) stay pending.
  UPDATE message_deliveries md
  SET status = 'delivered',
      delivered_at = NOW()
  FROM messages m
  WHERE md.message_id = m.id
    AND m.conversation_id = p_group_id
    AND md.recipient_agent_id = p_agent_id
    AND md.status = 'stored';

  -- Auto-promote earliest-joined member if the leaver was the last admin.
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

-- ─── 9. kick_member_atomic ────────────────────────────────────────────────
--
-- Admin-initiated soft-remove. Does NOT run the auto-promote logic because
-- kicks can't leave the group adminless: the creator can't be kicked and
-- the creator is always an admin. If the target is the creator, reject.
-- If the target is not an active member, return was_member=FALSE as a
-- no-op so the caller can surface "already gone" cleanly.

CREATE OR REPLACE FUNCTION kick_member_atomic(
  p_group_id  TEXT,
  p_target_id TEXT
) RETURNS TABLE(was_member BOOLEAN) AS $$
DECLARE
  v_creator TEXT;
  v_found   BOOLEAN;
BEGIN
  SELECT created_by INTO v_creator
  FROM conversations
  WHERE id = p_group_id
  FOR UPDATE;

  IF NOT FOUND THEN
    was_member := FALSE;
    RETURN NEXT;
    RETURN;
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

-- ─── 10. promote_to_admin_atomic ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION promote_to_admin_atomic(
  p_group_id  TEXT,
  p_target_id TEXT
) RETURNS BOOLEAN AS $$
DECLARE
  v_updated INTEGER;
BEGIN
  PERFORM 1 FROM conversations WHERE id = p_group_id FOR UPDATE;
  IF NOT FOUND THEN RETURN FALSE; END IF;

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

-- ─── 11. demote_admin_atomic ──────────────────────────────────────────────
--
-- Demotes an admin to member. Guards:
--   - Cannot demote the creator (creator is always admin).
--   - Cannot demote the last admin (group is never adminless while it has
--     members). Caller must promote someone else first.
-- Returns one of: 'ok', 'not_admin', 'last_admin', 'creator', 'not_found'.

CREATE OR REPLACE FUNCTION demote_admin_atomic(
  p_group_id  TEXT,
  p_target_id TEXT
) RETURNS TEXT AS $$
DECLARE
  v_creator     TEXT;
  v_role        TEXT;
  v_left_at     TIMESTAMPTZ;
  v_admin_count INTEGER;
BEGIN
  SELECT created_by INTO v_creator
  FROM conversations
  WHERE id = p_group_id
  FOR UPDATE;

  IF NOT FOUND THEN RETURN 'not_found'; END IF;
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

-- ─── 12. group_member_count ───────────────────────────────────────────────
--
-- Count of active members (left_at IS NULL). Cheap because of idx_cp_active.

CREATE OR REPLACE FUNCTION group_member_count(p_group_id TEXT)
RETURNS INTEGER AS $$
  SELECT COUNT(*)::INTEGER
  FROM conversation_participants
  WHERE conversation_id = p_group_id AND left_at IS NULL;
$$ LANGUAGE sql STABLE;
