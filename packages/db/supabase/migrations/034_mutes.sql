-- Migration 034: Per-recipient mute (suppress wake-up, keep envelope).
-- ==========================================================================
-- MOTIVATION (agent-first framing):
--   In human messaging, "mute" silences the OS banner — the message still
--   lands in the inbox. In an agent-first system the analog is stronger:
--   every webhook POST we fire is a *runtime invocation* on the recipient —
--   a container wake-up, an LLM call, context pollution, real dollars. A
--   chatty or hangout agent can trivially burn the receiver's compute
--   budget even when no single message is a problem.
--
--   Mute here means: the message is still persisted (message_deliveries
--   envelope written, undelivered_count bumped, /messages/sync returns
--   it normally) but the *wake-up signals* — the webhook fan-out AND the
--   real-time WebSocket push — are suppressed. The recipient picks the
--   message up whenever it next polls its inbox, exactly like a human
--   opens WhatsApp and sees messages from muted contacts waiting there.
--
--   This preserves the sender's delivered receipt (envelope exists) and
--   leaks no signal that they've been muted — same opacity as human mute.
--
-- SCOPE (MVP):
--   Two target kinds:
--     - 'agent'        — mute a specific sender across all conversations
--                        (including groups they appear in)
--     - 'conversation' — mute one conversation (usually a group), all
--                        senders within it
--   Not yet: per-member-in-group mute (would be (conversation_id,
--   sender_id) composite); temporary-mute UI ergonomics beyond the
--   muted_until column; batch mute ops. These are additive — the
--   (target_kind, target_id) shape already leaves room.
--
-- NON-GOALS:
--   - Mute is NOT block. Block stops the sender from delivering at all
--     (existing `blocks` table, migration 001). Mute keeps the envelope;
--     block drops it. A muted sender can still be unmuted without the
--     social signal of unblocking.
--   - Mute is NOT pause. paused_by_owner halts both envelope writes and
--     push for the recipient at the *owner* level (migration for pause is
--     upstream). Mute is a per-agent policy with envelope preservation.

-- 1. mutes table ----------------------------------------------------------

CREATE TABLE IF NOT EXISTS mutes (
  -- The agent who set the mute. CASCADE: if an agent is deleted, drop
  -- their mute list (it's personal state with no audit value).
  muter_agent_id  TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,

  -- 'agent' or 'conversation'. Kept as TEXT + CHECK rather than an ENUM
  -- type because adding a future kind ('conversation_member' etc.) is a
  -- one-line CHECK alter; enum ALTERs require more ceremony.
  target_kind     TEXT NOT NULL CHECK (target_kind IN ('agent', 'conversation')),

  -- agent_id when kind='agent', conversation_id when kind='conversation'.
  -- No FK: a conditional FK (valid-target-depends-on-kind) isn't
  -- expressible in vanilla PG without a trigger, and the app-layer
  -- mute service validates target existence before insert. If a target
  -- is deleted after the mute is set, the mute becomes a stale row —
  -- harmless (the NOT EXISTS check in send_message_atomic never fires
  -- because the conversation/sender is already gone) and a future
  -- cleanup sweep can GC stale rows if they accumulate.
  target_id       TEXT NOT NULL,

  -- NULL means "muted forever until unmuted". A future timestamp means
  -- "unmute automatically at this moment" — we don't have a scheduler
  -- deleting expired rows; the send-path query uses `muted_until IS NULL
  -- OR muted_until > NOW()` so an expired row is simply ignored. A
  -- background GC can be added later to reclaim the space.
  muted_until     TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (muter_agent_id, target_kind, target_id),

  -- An agent muting itself is meaningless (the sender-exclusion in
  -- send_message_atomic means they'd never receive their own message
  -- anyway) and suggests a client bug. Reject at the DB layer so no
  -- validation gap — even direct SQL callers can't create this.
  CONSTRAINT mutes_no_self_agent CHECK (
    NOT (target_kind = 'agent' AND target_id = muter_agent_id)
  )
);

COMMENT ON TABLE mutes IS
  'Per-muter suppression of webhook + WS wake-up for a target (agent or conversation). Envelopes still written; /messages/sync still returns muted messages.';

-- The PK already covers the hot-path lookup inside send_message_atomic
-- ("for this recipient, is there any active mute matching the sender or
-- conversation?"). No additional index needed for the write path.
--
-- For the operator-facing "list my mutes" read path, the PK's leftmost
-- column (muter_agent_id) lets us range-scan by muter efficiently.

-- 2. Updated send_message_atomic -----------------------------------------
--
-- Changes vs migration 031's version:
--   (a) The INSERT INTO message_outbox SELECT adds a NOT EXISTS subquery
--       against `mutes` — muted recipients get their envelope (we still
--       INSERT into message_deliveries for them) but NOT their outbox
--       row. No outbox row = no webhook, by construction.
--   (b) The RETURN TABLE gains a muted_recipient_ids TEXT[] column so
--       the TS caller (message.service.ts pushToGroup / pushToRecipient)
--       can skip WS fan-out for those same recipients without a second
--       DB round-trip.
--
-- Everything else is identical to the 031 version — message writes,
-- deliveries, backlog skip, replay path, sender exclusion. The diff is
-- minimal on purpose: the outbox filter is the only semantic change.
--
-- Postgres refuses to change OUT parameters via CREATE OR REPLACE (42P13
-- "cannot change return type of existing function"), so we DROP first.
-- Safe because the function lives inside this single migration
-- transaction: the DROP + CREATE either both land or neither does, and
-- no concurrent session can call the function in between. The argument
-- signature is pinned explicitly so a future signature change produces
-- a loud "function not found" here rather than silently dropping the
-- wrong overload.

DROP FUNCTION IF EXISTS send_message_atomic(
  TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB
);

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
  skipped_recipient_ids TEXT[],
  muted_recipient_ids   TEXT[]
) AS $$
DECLARE
  v_row        messages%ROWTYPE;
  v_seq        BIGINT;
  v_deleted_at TIMESTAMPTZ;
  v_conv_type  TEXT;
  v_cap        CONSTANT INT := 10000;
  v_skipped    TEXT[] := ARRAY[]::TEXT[];
  v_muted      TEXT[] := ARRAY[]::TEXT[];
  v_sole_recip TEXT;
  v_sole_count INT;
  v_rec        RECORD;
BEGIN
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
    muted_recipient_ids   := ARRAY[]::TEXT[];
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

    -- Compute the mute set for this send. A recipient is muted iff they
    -- have an active mute (muted_until NULL or future) matching EITHER
    -- the sender (kind='agent') OR this conversation (kind='conversation').
    -- Computing it once and stashing in v_muted lets us (a) filter the
    -- outbox insert below and (b) return it to the caller for WS
    -- fan-out filtering — one pass instead of two.
    SELECT COALESCE(array_agg(cp.agent_id), ARRAY[]::TEXT[]) INTO v_muted
    FROM conversation_participants cp
    WHERE cp.conversation_id = p_conversation_id
      AND cp.agent_id <> p_sender_id
      AND cp.left_at IS NULL
      AND cp.agent_id <> ALL(v_skipped)
      AND EXISTS (
        SELECT 1 FROM mutes m
        WHERE m.muter_agent_id = cp.agent_id
          AND (m.muted_until IS NULL OR m.muted_until > NOW())
          AND (
            (m.target_kind = 'agent' AND m.target_id = p_sender_id)
            OR (m.target_kind = 'conversation' AND m.target_id = p_conversation_id)
          )
      );

    -- Outbox: mirror of message_deliveries' recipient set minus muted.
    -- The envelope still exists in message_deliveries for muted
    -- recipients (so /messages/sync returns it); only the webhook
    -- fan-out (which the outbox drives) is suppressed.
    INSERT INTO message_outbox (id, message_id, conversation_id, target_agent_id, event)
    SELECT
      'obx_' || replace(gen_random_uuid()::text, '-', ''),
      v_row.id,
      p_conversation_id,
      cp.agent_id,
      'message.new'
    FROM conversation_participants cp
    WHERE cp.conversation_id = p_conversation_id
      AND cp.agent_id <> p_sender_id
      AND cp.left_at IS NULL
      AND cp.agent_id <> ALL(v_skipped)
      AND cp.agent_id <> ALL(v_muted);

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
    muted_recipient_ids   := v_muted;
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
    muted_recipient_ids   := ARRAY[]::TEXT[];
    RETURN NEXT;
    RETURN;
  END;
END;
$$ LANGUAGE plpgsql;
