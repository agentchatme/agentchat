-- Migration 012: Durable webhook delivery queue
--
-- Prior to this migration, fireWebhooks() ran the HTTP delivery inline in
-- the request-handling path. Three problems:
--
--   1. If the api-server process died mid-retry, the webhook was lost —
--      the retry loop only existed in process memory.
--   2. The retry window was 21 seconds (1s + 5s + 15s). A receiver that
--      was down for longer than that never got the event.
--   3. A flood of webhook attempts competed for request-handler time,
--      adding tail latency to unrelated message sends.
--
-- This migration moves webhook delivery to a persistent queue processed
-- by a background worker. The enqueue path (called from the request
-- handler) is a single INSERT — fast, durable, and decoupled from
-- actual HTTP delivery.
--
-- Retry schedule: 10s, 30s, 1m, 5m, 15m, 1h, 6h, 24h — 8 delays, so a
-- delivery exhausts retries after the 9th attempt (initial + 8 retries)
-- and lands in the 'dead' state ~31 hours after enqueue. Receivers that
-- recover within a day see every pending event replayed in order.

-- 1. Queue table -------------------------------------------------------------

CREATE TABLE webhook_deliveries (
  id                TEXT PRIMARY KEY,
  webhook_id        TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  -- Denormalized from webhooks so the worker doesn't need a join per poll.
  -- Webhook edits (URL/secret rotation) ARE reflected here, but only for
  -- future enqueues — rows in flight keep the credentials captured at
  -- enqueue time. This is usually what you want: a secret rotation shouldn't
  -- silently drop in-flight deliveries.
  --
  -- agent_id is also denormalized so the worker can mark the recipient's
  -- delivery envelope (message_deliveries row) on success without having
  -- to join back through webhooks.
  agent_id          TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  url               TEXT NOT NULL,
  secret            TEXT NOT NULL,

  event             TEXT NOT NULL,
  payload           JSONB NOT NULL,

  status            TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivering', 'delivered', 'failed', 'dead')),
  attempts          INT NOT NULL DEFAULT 0,
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_attempted_at TIMESTAMPTZ,
  last_error        TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at      TIMESTAMPTZ
);

-- Worker poll index: "next rows due for attempt, oldest first". Partial
-- index on the active states keeps it tiny — delivered/dead rows are the
-- vast majority of historical volume and are irrelevant to polling.
CREATE INDEX idx_whd_due
  ON webhook_deliveries(next_attempt_at ASC)
  WHERE status IN ('pending', 'failed', 'delivering');

-- Lookup for a webhook's recent history (debug / dashboard)
CREATE INDEX idx_whd_webhook ON webhook_deliveries(webhook_id, created_at DESC);

-- 2. Worker claim function ---------------------------------------------------
--
-- Claims up to p_limit rows atomically using FOR UPDATE SKIP LOCKED so
-- multiple workers (one per api-server instance) don't double-process the
-- same delivery. The claim flips status to 'delivering' and stamps
-- last_attempted_at so a worker crash becomes detectable.
--
-- Also reclaims rows stuck in 'delivering' for more than 60 seconds — if
-- a worker crashes mid-request, the row would otherwise be orphaned. The
-- 60s cutoff is comfortably longer than the 10s per-attempt HTTP timeout.
-- Reclaim can cause at-most-twice delivery in the rare case where the
-- previous worker succeeded but died before updating the DB; receivers
-- dedupe by message id so this is acceptable.

CREATE OR REPLACE FUNCTION claim_webhook_deliveries(p_limit INT)
RETURNS SETOF webhook_deliveries
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  UPDATE webhook_deliveries
  SET
    status = 'delivering',
    last_attempted_at = NOW(),
    attempts = attempts + 1
  WHERE id IN (
    SELECT id FROM webhook_deliveries
    WHERE (
      (status IN ('pending', 'failed') AND next_attempt_at <= NOW())
      OR (status = 'delivering' AND last_attempted_at < NOW() - INTERVAL '60 seconds')
    )
    ORDER BY next_attempt_at ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
END;
$$;
