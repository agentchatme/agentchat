-- Migration 030: Durable group-deletion fan-out queue
--
-- Prior to this migration, deleteGroup in the api-server fired the post-RPC
-- WS / webhook fan-out from a detached promise (`void (async () => …)()`).
-- Three problems:
--
--   1. If the api-server process died between delete_group_atomic returning
--      and the detached promise completing, recipients silently lost the
--      `group.deleted` event. They'd discover the deletion the next time
--      they tried to use the group (a 410 Gone) instead of getting the
--      live notification — a noticeably worse UX, especially in apps that
--      key client state off the live event.
--   2. fireWebhooks failures inside the detached loop were caught and
--      logged but never retried — a single transient DB hiccup during the
--      enqueue would drop the webhook for affected recipients.
--   3. There was no visibility into in-flight fan-out: nothing to query,
--      no metric for queue depth, no DLQ for failures.
--
-- This migration moves the fan-out to a persistent, per-recipient queue
-- populated atomically inside delete_group_atomic. The work is durable
-- the moment the delete commits, regardless of process lifecycle. The
-- background worker (group-deletion-fanout-worker) drains the queue with
-- the same FOR UPDATE SKIP LOCKED claim pattern used by webhook delivery
-- (migrations 012/026), so multiple worker machines cooperate without
-- double-processing.
--
-- Per-recipient row granularity (not per-group): a single transient
-- failure to fan out to recipient #4327 retries that one row, not the
-- whole 10K-recipient batch. UNIQUE(group_id, recipient_id) makes the
-- atomic enqueue idempotent under any future retry of the RPC itself.
--
-- Retry schedule (in worker, not here): 5s, 30s, 2m, 10m, 30m → ~43min
-- horizon. Tighter than the webhook schedule because fan-out failures
-- are almost always transient infrastructure (DB blip), not "receiver is
-- down for a day" — that case is already handled by webhook_deliveries
-- one layer down.

-- ─── 1. Queue table ────────────────────────────────────────────────────────

CREATE TABLE group_deletion_fanout (
  id                TEXT PRIMARY KEY,
  group_id          TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  recipient_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  -- The id of the 'group_deleted' system message inserted in the same
  -- transaction. The worker re-derives the WS / webhook payloads from
  -- (this row + group + actor) at drain time rather than denormalizing
  -- a snapshot here, so a renamed actor or updated group avatar doesn't
  -- ship a stale snapshot and the queue row stays small.
  system_msg_id     TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,

  status            TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivering', 'completed', 'dead')),
  attempts          INT NOT NULL DEFAULT 0,
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_attempted_at TIMESTAMPTZ,
  last_error        TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ,

  -- Idempotency under any future retry of delete_group_atomic. Also
  -- guards against a second concurrent enqueue if a future code path
  -- ever calls the enqueue helper directly.
  CONSTRAINT group_deletion_fanout_unique UNIQUE (group_id, recipient_id)
);

-- Worker poll index: "next rows due for attempt, oldest first". Partial
-- index keeps it tiny — completed/dead rows are the vast majority of
-- historical volume and are irrelevant to polling. Mirrors idx_whd_due
-- in webhook_deliveries.
CREATE INDEX idx_gdf_due
  ON group_deletion_fanout(next_attempt_at ASC)
  WHERE status IN ('pending', 'delivering');

-- Lookup by group for ops debugging ("show me what's stuck for group X")
-- and for the eventual dead-row scan inside the dlq-probe.
CREATE INDEX idx_gdf_group ON group_deletion_fanout(group_id, created_at DESC);

-- ─── 2. Atomic enqueue inside delete_group_atomic ─────────────────────────
--
-- We extend the existing function rather than adding a separate
-- enqueue_group_deletion_fanout RPC because:
--
--   * Atomicity: the queue rows commit in the same transaction as
--     deleted_at + the system message + the soft-leave UPDATE. There's no
--     window where the group is deleted but the fan-out is missing — a
--     race that the previous detached-promise approach left open.
--   * Single source of truth: callers don't need to remember to call two
--     RPCs in sequence. The queue is implicitly populated by the act of
--     deleting.
--
-- Return shape (seq, deleted_at) is unchanged — existing service-layer
-- callers don't need to be aware of the new queue at all.
--
-- Ordering matters: the INSERT into group_deletion_fanout MUST run before
-- the UPDATE that flips left_at on every participant, otherwise the
-- SELECT FROM conversation_participants would see an empty active set.
-- We slot it in right after the message + deliveries inserts and before
-- the soft-leave step.

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

  -- Authority check (unchanged from migration 019).
  IF v_creator = p_actor_id THEN
    SELECT a.status INTO v_creator_status
    FROM agents a
    WHERE a.id = p_actor_id;

    IF v_creator_status IN ('suspended', 'deleted') THEN
      RAISE EXCEPTION 'forbidden' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    SELECT a.status INTO v_creator_status
    FROM agents a
    WHERE a.id = v_creator;

    IF v_creator_status IS NULL OR v_creator_status NOT IN ('suspended', 'deleted') THEN
      RAISE EXCEPTION 'forbidden' USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT cp.role, cp.left_at INTO v_actor_role, v_actor_left_at
    FROM conversation_participants cp
    WHERE cp.conversation_id = p_group_id AND cp.agent_id = p_actor_id;

    IF NOT FOUND OR v_actor_left_at IS NOT NULL OR v_actor_role <> 'admin' THEN
      RAISE EXCEPTION 'forbidden_not_admin' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  -- 1. Write the final 'group_deleted' system message inline.
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

  -- 2. Fan-out envelopes for every non-sender, still-active participant.
  INSERT INTO message_deliveries (id, message_id, recipient_agent_id)
  SELECT
    'del_' || replace(gen_random_uuid()::text, '-', ''),
    p_system_msg_id,
    cp.agent_id
  FROM conversation_participants cp
  WHERE cp.conversation_id = p_group_id
    AND cp.agent_id <> p_actor_id
    AND cp.left_at IS NULL;

  -- 3. (NEW in 030) Enqueue durable fan-out for the live WS + webhook push.
  --    Mirrors the message_deliveries SELECT directly above — same set of
  --    recipients, same ordering. ON CONFLICT DO NOTHING makes the enqueue
  --    idempotent if the RPC ever ends up retried (e.g. a higher-level
  --    outbox replay), since we keyed UNIQUE(group_id, recipient_id).
  INSERT INTO group_deletion_fanout (id, group_id, recipient_id, system_msg_id)
  SELECT
    'gdf_' || replace(gen_random_uuid()::text, '-', ''),
    p_group_id,
    cp.agent_id,
    p_system_msg_id
  FROM conversation_participants cp
  WHERE cp.conversation_id = p_group_id
    AND cp.agent_id <> p_actor_id
    AND cp.left_at IS NULL
  ON CONFLICT (group_id, recipient_id) DO NOTHING;

  -- 4. Mark the conversation deleted.
  UPDATE conversations c
  SET deleted_at = v_now,
      deleted_by = p_actor_id
  WHERE c.id = p_group_id;

  -- 5. Soft-remove every remaining active member.
  UPDATE conversation_participants cp
  SET left_at = v_now
  WHERE cp.conversation_id = p_group_id
    AND cp.left_at IS NULL;

  -- 6. Flush stored envelopes for this conversation (except the new
  --    'group_deleted' envelope, which the recipient still needs to
  --    drain via /sync).
  UPDATE message_deliveries md
  SET status = 'delivered',
      delivered_at = v_now
  FROM messages m
  WHERE md.message_id = m.id
    AND m.conversation_id = p_group_id
    AND md.status = 'stored'
    AND md.message_id <> p_system_msg_id;

  -- 7. Cancel pending invites.
  DELETE FROM group_invitations
  WHERE conversation_id = p_group_id;

  seq := v_msg_seq;
  deleted_at := v_now;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql;

-- ─── 3. Worker claim function ─────────────────────────────────────────────
--
-- Mirrors claim_webhook_deliveries (migrations 012 + 026):
--   * FOR UPDATE SKIP LOCKED so multiple worker machines cooperate.
--   * Reclaims rows stuck in 'delivering' for > 60s (worker crash recovery).
--     60s is comfortably longer than any fan-out tick is expected to take.
--   * Increments attempts on claim — the worker decides when to mark
--     completed / scheduled / dead based on the new attempts value.

CREATE OR REPLACE FUNCTION claim_group_deletion_fanout(p_limit INT)
RETURNS SETOF group_deletion_fanout
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  UPDATE group_deletion_fanout
  SET
    status            = 'delivering',
    last_attempted_at = NOW(),
    attempts          = attempts + 1
  WHERE id IN (
    SELECT id FROM group_deletion_fanout
    WHERE (
      (status = 'pending' AND next_attempt_at <= NOW())
      OR (status = 'delivering' AND last_attempted_at < NOW() - INTERVAL '60 seconds')
    )
    ORDER BY next_attempt_at ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
END;
$$;

-- Service-role bypasses RLS but grant explicit EXECUTE so an operator
-- running the claim from the SQL editor doesn't get a permissions surprise.
GRANT EXECUTE ON FUNCTION claim_group_deletion_fanout(INT)
  TO anon, authenticated, service_role;
