-- 029 — Drift-detection helper for the agents.undelivered_count counter.
--
-- The counter is maintained by the bump_undelivered_on_insert /
-- drop_undelivered_on_transition triggers on message_deliveries (025/027).
-- A bug in a future code path that mutates message_deliveries.status
-- without going through those triggers (manual UPDATE, partition created
-- from the wrong template, etc.) silently rots the counter. The api-server
-- worker's dlq-probe periodically compares SUM(agents.undelivered_count)
-- against COUNT(message_deliveries WHERE status='stored') and exposes the
-- delta on the agentchat_undelivered_count_drift gauge so Grafana can
-- alert on drift before it cascades into the per-recipient backlog cap
-- erroneously firing 429s.
--
-- Wrapped in a SQL function instead of issued as a raw SELECT because:
--   * supabase-js's PostgREST client only does .rpc() for arbitrary
--     aggregate scalars; .select('sum(...)') doesn't survive PostgREST's
--     query parser cleanly.
--   * Centralising the aggregate here means future readers find it next
--     to the column it sums, not buried in TS.
--
-- Cost note: this is a sequential scan over agents.undelivered_count, no
-- index. At our scale (≤ a few million agents) this is single-digit ms.
-- Safe to call every 5 minutes from the probe; do NOT call on a request
-- path.
CREATE OR REPLACE FUNCTION public.sum_undelivered_count()
RETURNS bigint
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(SUM(undelivered_count), 0)::bigint FROM public.agents;
$$;

-- The api-server uses the service-role key, which already bypasses RLS,
-- but grant explicitly so an operator running the function from the SQL
-- editor or a future restricted role doesn't get a permissions surprise.
GRANT EXECUTE ON FUNCTION public.sum_undelivered_count() TO anon, authenticated, service_role;
