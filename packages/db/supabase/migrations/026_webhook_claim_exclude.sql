-- Migration 026: claim_webhook_deliveries accepts an exclude list (§3.4.3)
--
-- The webhook circuit breaker tracks per-endpoint health in Redis; when a
-- circuit is open (endpoint dead or degraded), its rows must be skipped at
-- CLAIM time rather than delivered-and-retried. Skipping at claim is
-- critical for two reasons:
--
--   1. The row stays in 'pending' — its next_attempt_at is unchanged, so
--      it's eligible again the moment the circuit recovers (no wasted
--      retry slot).
--   2. The attempts counter is NOT incremented. A webhook down for 30
--      minutes would otherwise burn through ~6 of the 9 attempts in the
--      retry schedule while the circuit is open, collapsing the 31h
--      horizon (§3.4.1) down to a fraction of its intended lifespan.
--
-- Backward-compatible: the new parameter is nullable and the old call
-- signature is preserved via default. Existing clients continue to work
-- without changes.

-- Drop the old unary signature first — PostgreSQL doesn't overload on
-- nullable default, so changing the shape requires an explicit DROP.
DROP FUNCTION IF EXISTS claim_webhook_deliveries(INT);

CREATE OR REPLACE FUNCTION claim_webhook_deliveries(
  p_limit              INT,
  p_exclude_webhook_ids TEXT[] DEFAULT NULL
)
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
      AND (
        p_exclude_webhook_ids IS NULL
        OR webhook_id <> ALL(p_exclude_webhook_ids)
      )
    ORDER BY next_attempt_at ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
END;
$$;
