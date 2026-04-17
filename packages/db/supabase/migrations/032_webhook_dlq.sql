-- Migration 032: Dedicated dead-letter queue for exhausted webhook deliveries.
-- ==========================================================================
-- BEFORE:
--   Exhausted webhook_deliveries rows (attempts == MAX_ATTEMPTS with a
--   non-2xx result) got status='dead' and stayed in the primary queue
--   table forever. Problems:
--     * No retention — dead rows accumulate in webhook_deliveries
--       indefinitely, polluting the claim index (idx_whd_due filters them
--       out by status but they still live on the heap and the
--       webhook_id/created_at secondary index).
--     * No replay path — operators who wanted to re-deliver a dead event
--       had to hand-compose a new row, getting the (url, secret, payload)
--       from the dead row and praying nothing had rotated.
--     * No ergonomic "what's in the DLQ right now?" query — scanning
--       webhook_deliveries with WHERE status='dead' mixes retention and
--       operational state in the same table.
--     * "dead" is a terminal status but lived alongside in-flight states,
--       which made `webhook_deliveries` conceptually overloaded.
--
-- AFTER:
--   A separate `webhook_deliveries_dlq` table is the terminal destination.
--   When webhook-worker.ts:scheduleNextAttempt hits MAX_ATTEMPTS, it calls
--   move_to_dlq() which atomically INSERTs the DLQ row and DELETEs the
--   webhook_deliveries row. Operators can replay via replay_webhook_dlq(),
--   which moves the row back to webhook_deliveries with fresh attempts=0.
--
-- Design notes:
--   - webhook_id is NULLABLE in the DLQ. If an operator deletes a webhook
--     between the original enqueue and a replay, the FK would otherwise
--     block the replay or cascade-delete the DLQ row. Nullable avoids
--     both, and we denormalize url/secret onto the DLQ row anyway so a
--     replay doesn't need the original webhook.
--   - agent_id keeps a hard FK with ON DELETE CASCADE — an agent being
--     deleted means every webhook they owned is gone, and replay has no
--     meaning.
--   - We retain the 'dead' value in the webhook_deliveries status CHECK
--     for in-flight rows mid-migration only. New code stops producing it
--     after this migration applies. A future cleanup can drop the value
--     from the CHECK constraint once we're confident no dead rows linger.

-- 1. Dead-letter table ----------------------------------------------------

CREATE TABLE IF NOT EXISTS webhook_deliveries_dlq (
  id                 TEXT PRIMARY KEY,
  -- NULLable: webhook rows can be deleted between send and replay. See
  -- header comment for the reasoning. Replay doesn't depend on this FK.
  webhook_id         TEXT REFERENCES webhooks(id) ON DELETE SET NULL,
  agent_id           TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  url                TEXT NOT NULL,
  secret             TEXT NOT NULL,
  event              TEXT NOT NULL,
  payload            JSONB NOT NULL,
  attempts           INT NOT NULL,
  last_error         TEXT,
  first_attempted_at TIMESTAMPTZ,
  last_attempted_at  TIMESTAMPTZ NOT NULL,
  -- When the row transitioned into the DLQ. Used by the probe's rolling
  -- window (countDeadWebhookDeliveries) and by retention jobs.
  dead_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Bookkeeping for manual replay. replayed_as_id points to the new
  -- webhook_deliveries row so the audit trail ties replay → original.
  replayed_at        TIMESTAMPTZ,
  replayed_as_id     TEXT
);

-- Time-ordered index for the rolling-window count queries the dlq-probe
-- runs. Partial on rows that haven't been replayed yet — a replayed row
-- is no longer the operator's problem.
CREATE INDEX IF NOT EXISTS idx_whd_dlq_recent
  ON webhook_deliveries_dlq (dead_at DESC)
  WHERE replayed_at IS NULL;

-- Per-agent lookup for dashboards ("show me every dead delivery for my
-- agent"). No partial filter — dashboards do want to see replayed ones too.
CREATE INDEX IF NOT EXISTS idx_whd_dlq_agent
  ON webhook_deliveries_dlq (agent_id, dead_at DESC);

COMMENT ON TABLE webhook_deliveries_dlq IS
  'Dead-letter queue for webhook deliveries that exhausted their retry budget (~31h, 9 attempts). Replayable via replay_webhook_dlq().';

-- 2. move_to_dlq ----------------------------------------------------------

-- Called by webhook-worker.ts when a delivery exhausts its retry budget.
-- Atomic INSERT DLQ + DELETE from webhook_deliveries so the row can't be
-- double-counted or double-processed after this transaction commits.
--
-- We keep the original delivery id on the DLQ row (primary key) so log
-- correlation still works — `grep whd_XXXXXX logs` continues to find
-- both the original attempts and the DLQ landing event.
CREATE OR REPLACE FUNCTION move_to_dlq(
  p_delivery_id TEXT,
  p_last_error  TEXT
) RETURNS VOID AS $$
DECLARE
  v_row webhook_deliveries%ROWTYPE;
BEGIN
  SELECT * INTO v_row
  FROM webhook_deliveries
  WHERE id = p_delivery_id;

  IF NOT FOUND THEN
    -- Row already moved (concurrent worker, manual cleanup) — benign.
    RETURN;
  END IF;

  INSERT INTO webhook_deliveries_dlq (
    id, webhook_id, agent_id, url, secret, event, payload,
    attempts, last_error, first_attempted_at, last_attempted_at
  ) VALUES (
    v_row.id,
    v_row.webhook_id,
    v_row.agent_id,
    v_row.url,
    v_row.secret,
    v_row.event,
    v_row.payload,
    v_row.attempts,
    LEFT(COALESCE(p_last_error, v_row.last_error), 1024),
    v_row.created_at,
    COALESCE(v_row.last_attempted_at, NOW())
  )
  -- In the rare race where both workers try to move the same row, the
  -- first wins via PK and the second silently drops. The DELETE below
  -- still runs and resolves the webhook_deliveries side.
  ON CONFLICT (id) DO NOTHING;

  DELETE FROM webhook_deliveries WHERE id = p_delivery_id;
END;
$$ LANGUAGE plpgsql;

-- 3. replay_webhook_dlq ---------------------------------------------------

-- Operator-facing replay path. Moves a DLQ row back into
-- webhook_deliveries with a fresh attempts counter and next_attempt_at
-- set to NOW, so the worker picks it up on the next tick.
--
-- If the underlying webhook was deleted between dead and replay,
-- webhook_id on the DLQ row is NULL — we still replay but the new
-- webhook_deliveries row has NULL webhook_id, which would violate the
-- FK. In that case we raise — the operator should enqueue a fresh
-- webhook instead of trying to resurrect a deleted subscription.
--
-- Returns the new webhook_deliveries id so the caller (dashboard, CLI)
-- can follow up with a status check.
CREATE OR REPLACE FUNCTION replay_webhook_dlq(
  p_dlq_id    TEXT,
  p_new_id    TEXT
) RETURNS TEXT AS $$
DECLARE
  v_row webhook_deliveries_dlq%ROWTYPE;
BEGIN
  SELECT * INTO v_row
  FROM webhook_deliveries_dlq
  WHERE id = p_dlq_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'dlq row % not found', p_dlq_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_row.replayed_at IS NOT NULL THEN
    RAISE EXCEPTION 'dlq row % already replayed as %', p_dlq_id, v_row.replayed_as_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF v_row.webhook_id IS NULL THEN
    RAISE EXCEPTION 'cannot replay dlq row %: underlying webhook has been deleted', p_dlq_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  INSERT INTO webhook_deliveries (
    id, webhook_id, agent_id, url, secret, event, payload,
    status, attempts, next_attempt_at, last_error
  ) VALUES (
    p_new_id,
    v_row.webhook_id,
    v_row.agent_id,
    v_row.url,
    v_row.secret,
    v_row.event,
    v_row.payload,
    'pending',
    0,
    NOW(),
    NULL
  );

  UPDATE webhook_deliveries_dlq
  SET replayed_at = NOW(),
      replayed_as_id = p_new_id
  WHERE id = p_dlq_id;

  RETURN p_new_id;
END;
$$ LANGUAGE plpgsql;

-- 4. Migrate any existing dead rows into the DLQ --------------------------

-- Phase 1 platform: there shouldn't be any dead rows in production yet.
-- Run as an idempotent sweep anyway so a future operator re-running this
-- migration (or rolling forward from a dev snapshot with dead rows)
-- lands in the same state as a fresh apply. No-op when the source set
-- is empty, which is the expected production case.
WITH sweep AS (
  SELECT * FROM webhook_deliveries WHERE status = 'dead'
)
INSERT INTO webhook_deliveries_dlq (
  id, webhook_id, agent_id, url, secret, event, payload,
  attempts, last_error, first_attempted_at, last_attempted_at, dead_at
)
SELECT
  id,
  webhook_id,
  agent_id,
  url,
  secret,
  event,
  payload,
  attempts,
  last_error,
  created_at,
  COALESCE(last_attempted_at, created_at),
  -- Preserve the landing time as best we can. If last_attempted_at is
  -- populated that's the closest proxy to the original dead_at; fall
  -- back to created_at otherwise. The gauge cares about rolling-window
  -- counts so being off by a few seconds is harmless; this just keeps
  -- the rollup from suddenly spiking the "last hour" counter.
  COALESCE(last_attempted_at, created_at)
FROM sweep
ON CONFLICT (id) DO NOTHING;

DELETE FROM webhook_deliveries WHERE status = 'dead';

-- We do NOT remove 'dead' from the status CHECK constraint yet. Leaving
-- it in place means a stale worker build that still calls markWebhookDead
-- after this migration applies won't crash — it just writes a row that
-- gets picked up and re-moved by the next move-to-dlq tick. A later
-- cleanup migration can drop the value once every running worker binary
-- is post-032.
