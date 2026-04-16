-- Migration 028: Partition messages and message_deliveries by month.
--
-- DESTRUCTIVE PRE-LAUNCH MIGRATION. Drops messages, message_deliveries,
-- and message_hides, then recreates them as native range-partitioned
-- tables keyed on created_at. Acceptable only because we have no real
-- traffic yet; running this against a production database with data will
-- destroy that data.
--
-- WHY PARTITIONING NOW: at agent scale (1M agents × ~10 msg/day = ~10M
-- msg/day = ~3.6B msg/year), an unpartitioned messages table forces every
-- index to span the full row count, autovacuum runs become hour-long
-- pauses, and DROPing old data requires a multi-day delete. Monthly
-- partitions cap each child at one month's worth of rows, let pg_partman
-- detach old months in milliseconds, and let queries with a created_at
-- filter prune entire partitions out of the plan.
--
-- WHY DROP NOT MIGRATE: native partitioning requires the partition key
-- (created_at) in every PRIMARY KEY and UNIQUE constraint. The existing
-- table's PK is (id) alone. Switching the PK in place would require
-- copying every row to a new table anyway — no perf win over drop+recreate
-- for an empty schema, and the migration stays readable.
--
-- WHY THE FK FROM message_deliveries → messages IS GONE: PG only allows
-- FKs into a partitioned table via the partition key in the parent's
-- unique constraint. Our deliveries reference (message_id) alone, which
-- can't be unique cross-partition. Application-level integrity is
-- enforced by send_message_atomic() inserting both rows in the same
-- transaction — the message and its delivery envelopes share the same
-- created_at by construction so they always land in the same partition.
--
-- WHY message_hides IS NOT PARTITIONED: low row count (one row per
-- (message, hider)), and the access pattern is always
-- (message_id IN (…), agent_id = $1) which the composite PK index
-- resolves regardless of total table size. Skipping partitioning keeps
-- the hide path simple.

-- 1. pg_partman extension ---------------------------------------------------
-- Supabase ships pg_partman v5.x and pins all extensions into the
-- `extensions` schema (cluster-wide policy, not configurable per extension).
-- So all pg_partman objects (create_parent, run_maintenance_proc,
-- part_config) live under the `extensions.` namespace, not `partman.`.
CREATE EXTENSION IF NOT EXISTS pg_partman;

-- 2. Drop existing tables (CASCADE clears dependent FKs) --------------------
-- IF EXISTS keeps this idempotent across reruns. Templates included so a
-- prior failed run that created them but didn't finish doesn't leave the
-- next attempt blocked on "relation already exists".
DROP TABLE IF EXISTS message_hides                CASCADE;
DROP TABLE IF EXISTS message_deliveries           CASCADE;
DROP TABLE IF EXISTS message_deliveries_template  CASCADE;
DROP TABLE IF EXISTS messages                     CASCADE;
DROP TABLE IF EXISTS messages_template            CASCADE;

-- Clear pg_partman's own bookkeeping so create_parent below doesn't fail
-- with "parent table already configured" if a prior run got past one
-- create_parent call before failing on the next.
DELETE FROM extensions.part_config
 WHERE parent_table IN ('public.messages', 'public.message_deliveries');

-- 3. messages (partitioned by created_at) -----------------------------------
CREATE TABLE messages (
  id              TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       TEXT NOT NULL REFERENCES agents(id),
  client_msg_id   TEXT NOT NULL,
  seq             BIGINT NOT NULL,
  type            TEXT NOT NULL DEFAULT 'text'
    CHECK (type IN ('text', 'structured', 'file', 'system')),
  content         JSONB NOT NULL,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Indexes on the parent — pg_partman propagates these to every partition,
-- old and new. Partition pruning by created_at filter handles the rest.
CREATE INDEX idx_messages_conv_created ON messages (conversation_id, created_at DESC);
CREATE INDEX idx_messages_conv_seq     ON messages (conversation_id, seq DESC);
CREATE INDEX idx_messages_sender       ON messages (sender_id);

-- Per-partition uniqueness for (sender_id, client_msg_id). The parent can't
-- carry this constraint without including created_at in the key (PG
-- partition rule), so we use a template table that pg_partman clones onto
-- every new partition. The cross-partition gap is plugged by the 24h HTTP
-- idempotency middleware (see middleware/idempotency.ts) — a real client
-- retry can never cross a month boundary inside that window, so per-month
-- uniqueness is functionally global for the retry use case.
CREATE TABLE messages_template (LIKE messages);
ALTER TABLE messages_template
  ADD CONSTRAINT messages_template_sender_client_msg_id_unique
  UNIQUE (sender_id, client_msg_id);

-- Bootstrap pg_partman. Premake 12 months of forward partitions so the
-- table is never caught without a target partition for an incoming write.
-- retention = NULL means we keep history forever; flip this once the
-- archival policy is decided (e.g. retention => '2 years',
-- retention_keep_table => false to auto-detach + drop).
SELECT extensions.create_parent(
  p_parent_table   := 'public.messages',
  p_control        := 'created_at',
  p_interval       := '1 month',
  p_premake        := 12,
  p_template_table := 'public.messages_template'
);

-- 4. message_deliveries (partitioned by created_at) -------------------------
CREATE TABLE message_deliveries (
  id                  TEXT NOT NULL,
  message_id          TEXT NOT NULL,
  recipient_agent_id  TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'stored'
    CHECK (status IN ('stored', 'delivered', 'read')),
  delivered_at        TIMESTAMPTZ,
  read_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Sync drain hot path: oldest stored deliveries for this recipient. Partial
-- so delivered/read rows (the bulk of the table once steady state) don't
-- bloat the index. Lives on the parent → pg_partman propagates.
CREATE INDEX idx_md_recipient_stored
  ON message_deliveries (recipient_agent_id, created_at ASC)
  WHERE status = 'stored';

-- Read-receipt composition: which envelopes belong to this message.
CREATE INDEX idx_md_message ON message_deliveries (message_id);

CREATE TABLE message_deliveries_template (LIKE message_deliveries);
-- Per-partition uniqueness on (message_id, recipient_agent_id). Same logic
-- as messages.client_msg_id: a single send_message_atomic transaction
-- inserts message + envelopes with the same created_at, so the (message,
-- recipient) tuple is unique within a partition by construction. Catches
-- a buggy fan-out re-insert if it ever happens.
ALTER TABLE message_deliveries_template
  ADD CONSTRAINT md_template_message_recipient_unique
  UNIQUE (message_id, recipient_agent_id);

SELECT extensions.create_parent(
  p_parent_table   := 'public.message_deliveries',
  p_control        := 'created_at',
  p_interval       := '1 month',
  p_premake        := 12,
  p_template_table := 'public.message_deliveries_template'
);

-- 5. Forward-only delivery status trigger -----------------------------------
-- Re-create on the new parent. Triggers on partitioned parents fire for
-- every partition's row events automatically (PG 11+).
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

-- 6. message_hides (regular table) ------------------------------------------
CREATE TABLE message_hides (
  message_id  TEXT NOT NULL,
  agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  hidden_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, agent_id)
);

-- 7. Re-create hide_message_for_agent ---------------------------------------
-- Body is unchanged from migration 016; redeclared here because the table
-- it touches was just dropped and recreated.
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

-- 8. Re-create send_message_atomic (carries forward 027's group lock fix) ---
-- Body identical to migration 027 — replayed here because the messages and
-- message_deliveries tables it writes to were just dropped and recreated.
-- The function's plpgsql body is parsed at first call so it doesn't break
-- when the underlying tables get rebuilt, but redeclaring is safer in case
-- a connection had a cached plan from before.
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

-- 9. Operator follow-up (pg_cron) -------------------------------------------
-- pg_partman doesn't auto-schedule; it expects pg_cron (or any external
-- scheduler) to call partman.run_maintenance_proc() periodically. After
-- this migration applies, run ONCE in the Supabase SQL editor:
--
--   CREATE EXTENSION IF NOT EXISTS pg_cron;
--   SELECT cron.schedule(
--     'partman-maintenance',
--     '0 4 * * *',                          -- 04:00 UTC daily
--     $$ CALL extensions.run_maintenance_proc() $$
--   );
--
-- The job tops up forward partitions (so the table is never caught short)
-- and applies retention if/when configured. Migration can't run this
-- itself because pg_cron must be enabled by an admin in the Supabase
-- dashboard before CREATE EXTENSION will succeed.
