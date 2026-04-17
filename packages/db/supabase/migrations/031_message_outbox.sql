-- Migration 031: Message outbox for transactional webhook fan-out.
-- ==========================================================================
-- BEFORE:
--   send_message_atomic commits (message + message_deliveries durable), then
--   the api-server layer calls fireWebhooks() which issues INSERT INTO
--   webhook_deliveries for each subscriber. If the api-server dies in that
--   post-commit gap — process crash, Fly drain, SIGKILL — the message is
--   durable but the webhook events are gone. Webhook receivers (which is
--   how AI agents typically consume messages) silently miss the event.
--   /sync isn't a substitute: the sync endpoint lives at the
--   sender/recipient device level, not the webhook subscriber level, and
--   there's no catch-up machinery there.
--
-- AFTER:
--   send_message_atomic writes a `message_outbox` row per recipient in the
--   SAME transaction as messages + message_deliveries. A background
--   outbox-worker claims rows (FOR UPDATE SKIP LOCKED, 60s stale reclaim),
--   loads the target's webhook subscriptions, and atomically inserts
--   webhook_deliveries + deletes the outbox row via process_outbox_row.
--   Either everything commits, or a retry processes the row next tick. No
--   post-commit loss window.
--
-- This is the standard "transactional outbox" pattern: you cannot
-- atomically commit a DB write AND an external side effect (the webhook
-- ENQUEUE is a DB write, so we CAN make it atomic — we just weren't).
--
-- Idempotency under reclaim race:
--   If a worker claims a row, stalls past the 60s threshold, and a second
--   worker reclaims and processes concurrently, both attempts write
--   webhook_deliveries with DETERMINISTIC ids derived from (outbox_id,
--   webhook_id). The ON CONFLICT DO NOTHING on webhook_deliveries.id
--   collapses the duplicate. Subsequent DELETE of the outbox row is a
--   no-op on the later caller. Net: at-least-once enqueue, exactly-once
--   persisted row.
--
-- Destructive? No. Pure additive — one new table, one new index, one
-- refreshed function body. Existing rows are unaffected; new sends start
-- producing outbox rows immediately after this migration applies.

-- 1. Outbox table ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS message_outbox (
  id               TEXT PRIMARY KEY,
  message_id       TEXT NOT NULL,
  conversation_id  TEXT NOT NULL,
  target_agent_id  TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  event            TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at       TIMESTAMPTZ,
  attempts         INT NOT NULL DEFAULT 0,
  last_error       TEXT
);

-- We do NOT FK message_id → messages(id). The messages table is partitioned
-- (mig 028) and Postgres forbids FKs referencing partitioned tables. The
-- referential integrity we'd get from the FK is already implicit: outbox
-- rows are only written alongside a successful INSERT INTO messages in the
-- same transaction, so dangling message_ids can't exist. If/when mig 028's
-- retention kicks in and a partition drops, any outbox rows referencing
-- that partition would be orphaned, but outbox rows live at most seconds
-- in practice (worker polls every 500ms) — no window for partition-drop
-- collision.

-- Unclaimed work queue: index exists for the worker's claim query only.
-- Partial index to keep it tight — processed rows (deleted) and claimed
-- rows (claimed_at IS NOT NULL) aren't interesting here.
CREATE INDEX IF NOT EXISTS idx_outbox_unclaimed
  ON message_outbox (created_at ASC)
  WHERE claimed_at IS NULL;

-- Stale-claim reclaim: used by claim_message_outbox to null-out rows a
-- dead worker left in 'claimed' state. Partial index because we only care
-- about rows that are currently claimed.
CREATE INDEX IF NOT EXISTS idx_outbox_stale_claimed
  ON message_outbox (claimed_at ASC)
  WHERE claimed_at IS NOT NULL;

COMMENT ON TABLE message_outbox IS
  'Transactional outbox for webhook fan-out. One row per (message × target_agent) written inside send_message_atomic; outbox-worker drains into webhook_deliveries.';

-- 2. Refresh send_message_atomic to write outbox rows in-transaction ------

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

    -- Outbox: mirror of message_deliveries' recipient set, one row per
    -- target_agent. Same filter — anyone who gets a delivery row gets an
    -- outbox row. Backlogged recipients (in v_skipped) were excluded from
    -- deliveries and are likewise excluded here: if we didn't persist an
    -- envelope for them, we certainly shouldn't fire a webhook.
    --
    -- NOTE: we do NOT write an outbox row for the sender. Senders do not
    -- receive a 'message.new' webhook — the event belongs to recipients.
    -- This matches the previous fireWebhooks() call-sites in
    -- message.service.ts (pushToGroup + pushToRecipient), which only
    -- invoked for recipients.
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

-- 3. claim_message_outbox -------------------------------------------------

-- Worker entrypoint. Two-phase:
--   (a) release any row whose claimed_at is older than the stale threshold
--       (worker died mid-process; we need to let another worker take over).
--   (b) claim up to p_limit unclaimed rows, bump attempts, set claimed_at.
-- Returns the claimed batch so the worker can process them without another
-- round-trip.
--
-- FOR UPDATE SKIP LOCKED semantics: multiple worker processes poll
-- concurrently; each worker gets a disjoint slice of the queue. Rows being
-- claimed by another worker are silently skipped in this batch and picked
-- up on the next tick.
CREATE OR REPLACE FUNCTION claim_message_outbox(p_limit INT)
RETURNS TABLE(
  id              TEXT,
  message_id      TEXT,
  conversation_id TEXT,
  target_agent_id TEXT,
  event           TEXT,
  attempts        INT
) AS $$
DECLARE
  v_stale_threshold CONSTANT INTERVAL := '60 seconds';
BEGIN
  -- Phase (a): reclaim abandoned rows. The stale threshold matches the
  -- webhook_deliveries reclaim logic — the outbox worker's per-row budget
  -- is much tighter (no external HTTP call, just a local DB transaction),
  -- so 60s is generous. If we see steady-state stale reclaims, something
  -- is very wrong (GC pause, DB timeout). Sentry should be loud.
  UPDATE message_outbox mo
  SET claimed_at = NULL,
      last_error = COALESCE('stale_reclaim@' || NOW()::text, mo.last_error)
  WHERE mo.claimed_at IS NOT NULL
    AND mo.claimed_at < NOW() - v_stale_threshold;

  -- Phase (b): claim a fresh batch. ORDER BY created_at so we drain FIFO —
  -- matters for per-conversation perceived order on webhook receivers.
  -- (Across conversations, strict order isn't a product guarantee; see
  -- the long comment in realtime.ts.)
  RETURN QUERY
  WITH picked AS (
    SELECT mo.id
    FROM message_outbox mo
    WHERE mo.claimed_at IS NULL
    ORDER BY mo.created_at ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE message_outbox mo
  SET claimed_at = NOW(),
      attempts = mo.attempts + 1
  FROM picked p
  WHERE mo.id = p.id
  RETURNING mo.id, mo.message_id, mo.conversation_id, mo.target_agent_id, mo.event, mo.attempts;
END;
$$ LANGUAGE plpgsql;

-- 4. process_outbox_row ---------------------------------------------------

-- Atomically INSERT webhook_deliveries + DELETE the outbox row. This is
-- the half of the outbox transaction that crosses the queue-to-queue
-- boundary; keeping it inside a single plpgsql call means a caller crash
-- here is fine — Postgres rolls back the INSERT and the DELETE together,
-- and the next claim_message_outbox tick finds the row still live.
--
-- p_webhook_rows is a JSONB array shaped as:
--   [
--     { "id": "wdl_...", "webhook_id": "whk_...", "url": "...",
--       "secret": "...", "payload": {...} }
--   ]
-- The `id` is pre-composed by the worker and derived deterministically
-- from (outbox_id, webhook_id) so reclaim races collapse at the primary
-- key. ON CONFLICT DO NOTHING absorbs the duplicate without error.
--
-- If the target has no webhooks for this event, p_webhook_rows is an
-- empty array — we still delete the outbox row (it has been resolved;
-- there's just nothing to persist downstream).
CREATE OR REPLACE FUNCTION process_outbox_row(
  p_outbox_id    TEXT,
  p_webhook_rows JSONB
) RETURNS VOID AS $$
DECLARE
  v_exists INT;
BEGIN
  -- Verify the row is still claimed by some worker. If it was already
  -- processed and deleted (benign double-process), just exit cleanly.
  SELECT 1 INTO v_exists FROM message_outbox WHERE id = p_outbox_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF p_webhook_rows IS NOT NULL AND jsonb_array_length(p_webhook_rows) > 0 THEN
    INSERT INTO webhook_deliveries (
      id, webhook_id, agent_id, url, secret, event, payload
    )
    SELECT
      rec->>'id',
      rec->>'webhook_id',
      rec->>'agent_id',
      rec->>'url',
      rec->>'secret',
      rec->>'event',
      rec->'payload'
    FROM jsonb_array_elements(p_webhook_rows) AS rec
    ON CONFLICT (id) DO NOTHING;
  END IF;

  DELETE FROM message_outbox WHERE id = p_outbox_id;
END;
$$ LANGUAGE plpgsql;

-- 5. record_outbox_failure ------------------------------------------------

-- Worker calls this when it encounters a processing error it can't
-- resolve. Releases the claim (so another worker or the next tick picks
-- the row up) and stores the error message for observability.
CREATE OR REPLACE FUNCTION record_outbox_failure(
  p_outbox_id TEXT,
  p_error     TEXT
) RETURNS VOID AS $$
BEGIN
  UPDATE message_outbox
  SET claimed_at = NULL,
      last_error = p_error
  WHERE id = p_outbox_id;
END;
$$ LANGUAGE plpgsql;
