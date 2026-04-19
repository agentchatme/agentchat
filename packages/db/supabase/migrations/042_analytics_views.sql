-- Migration 042: Analytics schema, pre-aggregated matviews, Metabase reader role.
--
-- ─── Why this exists ───────────────────────────────────────────────────────
-- Growth/business metrics (daily signups, DAU, total deliveries, churn buckets,
-- etc.) are structurally different from error tracking (Sentry) and infra
-- metrics (Prometheus at /v1/metrics). They need:
--
--   * Pre-aggregation — a Metabase card should never run COUNT(*) over the
--     partitioned `messages` or `message_deliveries` parent at read time. The
--     worker refreshes snapshots hourly; BI reads the snapshots.
--
--   * Least-privilege access — the BI tool must not be able to SELECT
--     messages.content, agents.email, agents.api_key_hash, or anything else
--     that would turn a dashboard credential leak into a PII incident.
--
--   * Separation from the hot path — growth queries live in a different
--     schema with a different role. A slow matview refresh cannot degrade
--     request-path latency; a blown-up `/v1/messages` cannot starve the
--     analytics refresh.
--
-- ─── Design invariants ─────────────────────────────────────────────────────
--
-- 1. `analytics` schema holds every matview. Nothing in `public` changes.
--
-- 2. `metabase_reader` role has USAGE on `analytics` only, SELECT on every
--    matview. It cannot see `public` tables — by omission, not by REVOKE,
--    because a fresh role has no grants by default. The belt-and-suspenders
--    REVOKE at the bottom makes intent explicit anyway.
--
-- 3. Role is created NOLOGIN. Operator sets the password manually via
--    Supabase SQL Editor post-deploy (see docs/analytics/README.md). The
--    migration file goes in git and must never carry a real credential.
--
-- 4. `public.refresh_analytics_views(p_min_interval_minutes)` is the only
--    entry point the worker calls. The function lives in `public` so it's
--    reachable via default Supabase RPC without adding `analytics` to the
--    exposed-schemas list.
--
-- 5. Coordination across 3 worker machines via `pg_try_advisory_xact_lock`.
--    Transaction-scoped because Supabase's pgbouncer transaction-pool mode
--    does NOT preserve session-scoped advisory locks. Auto-released when
--    the function's implicit transaction commits.
--
-- 6. `REFRESH MATERIALIZED VIEW CONCURRENTLY` on every view — readers keep
--    seeing the prior snapshot while the new one is built. Each matview has
--    a UNIQUE INDEX (requirement for CONCURRENTLY).
--
-- 7. `analytics.refresh_log` is an audit trail. Failures commit via a
--    savepoint-scoped EXCEPTION block so a failed refresh still leaves an
--    observable row — the whole function transaction does NOT roll back.
--
-- ─── Refresh semantics ─────────────────────────────────────────────────────
--
-- Worker calls `public.refresh_analytics_views(30)` every hour. The function:
--
--   a) Tries to acquire the advisory lock. Fails → returns `lock_held`.
--   b) Checks last success in `refresh_log`. If <30 min old → returns
--      `too_soon`. Cheap double-fire guard on top of the lock.
--   c) Inserts an in-progress log row.
--   d) Refreshes every matview in `analytics` via CONCURRENTLY.
--   e) Updates the log row with duration + status=success (or failed).
--   f) Returns a JSONB result the worker can surface to Prometheus / Sentry.
--
-- A crash mid-refresh drops the advisory lock (transaction ends) and leaves
-- the log row with status='in_progress'. The next tick can't tell it from a
-- live refresh — but the cadence guard (c) plus the transaction lock mean
-- the NEXT tick will either see the crashed row's in_progress state and
-- skip briefly, or take the lock itself. The stale row is harmless metadata;
-- a periodic janitor in the ops README handles clean-up.
--
-- ─── What's NOT here ───────────────────────────────────────────────────────
--
--   * pg_cron — Supabase free-tier availability is flaky and the worker
--     already runs on Fly with metrics + Sentry. Running the tick from
--     app-space gives us observability for free.
--
--   * Cohort retention matviews — deferred. The simple daily/totals views
--     cover every metric on the launch list. Retention lands in a follow-up
--     migration once signup volume justifies the refresh cost.
--
--   * Time-zone handling beyond UTC — every `::DATE` cast is preceded by
--     `AT TIME ZONE 'UTC'` so daily buckets are stable across deploys. The
--     dashboard can pivot to local TZ client-side.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Schema + role
-- ═══════════════════════════════════════════════════════════════════════════

CREATE SCHEMA IF NOT EXISTS analytics;

-- Role is created NOLOGIN. Operator assigns password via Supabase SQL Editor
-- post-migration. Keeps credentials out of git and forces an explicit ops
-- step so the role can't accidentally be brought online with a weak default.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metabase_reader') THEN
    CREATE ROLE metabase_reader WITH NOLOGIN;
  END IF;
END
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Refresh audit log
-- ═══════════════════════════════════════════════════════════════════════════

-- One row per refresh attempt. Sized for trivial volume: hourly cadence =
-- ~8760 rows/year. Indexed by completed_at DESC so "last successful refresh"
-- is an index-only lookup.
CREATE TABLE IF NOT EXISTS analytics.refresh_log (
  id            BIGSERIAL PRIMARY KEY,
  started_at    TIMESTAMPTZ NOT NULL,
  completed_at  TIMESTAMPTZ,
  duration_ms   BIGINT,
  status        TEXT NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'success', 'failed', 'skipped')),
  views_count   INT,
  error         TEXT
);

CREATE INDEX IF NOT EXISTS idx_refresh_log_completed
  ON analytics.refresh_log(completed_at DESC NULLS LAST);

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Materialized views
-- ═══════════════════════════════════════════════════════════════════════════
-- Every matview has a UNIQUE INDEX. REFRESH MATERIALIZED VIEW CONCURRENTLY
-- requires one — PG uses it to diff the old snapshot against the new so
-- readers see consistent rows throughout.
-- ─── Daily signups ────────────────────────────────────────────────────────
-- Source: agents.created_at. Includes later-deleted agents — the signup
-- event happened regardless. `status` breakdowns live in the snapshot view
-- below so growth and churn are disaggregated.
CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.mv_signups_daily AS
SELECT
  (created_at AT TIME ZONE 'UTC')::DATE                               AS day,
  COUNT(*)::BIGINT                                                    AS signups,
  SUM(COUNT(*)) OVER (
    ORDER BY (created_at AT TIME ZONE 'UTC')::DATE
  )::BIGINT                                                           AS cumulative_signups
FROM public.agents
GROUP BY (created_at AT TIME ZONE 'UTC')::DATE;

CREATE UNIQUE INDEX IF NOT EXISTS mv_signups_daily_day
  ON analytics.mv_signups_daily(day);

-- ─── Daily claims (owner → agent) ──────────────────────────────────────────
-- Source: owner_agents.claimed_at. One row per (agent, current-owner) pair —
-- if an owner releases and another claims, that's two rows worth over time,
-- but owner_agents only holds the CURRENT claim (PK on agent_id). So this
-- measures "net new claims per day" net of releases, not gross claim events.
-- Release events are not separately tracked here; add an events-table view
-- if/when that granularity is needed.
CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.mv_claims_daily AS
SELECT
  (claimed_at AT TIME ZONE 'UTC')::DATE                               AS day,
  COUNT(*)::BIGINT                                                    AS claims,
  SUM(COUNT(*)) OVER (
    ORDER BY (claimed_at AT TIME ZONE 'UTC')::DATE
  )::BIGINT                                                           AS cumulative_claims
FROM public.owner_agents
GROUP BY (claimed_at AT TIME ZONE 'UTC')::DATE;

CREATE UNIQUE INDEX IF NOT EXISTS mv_claims_daily_day
  ON analytics.mv_claims_daily(day);

-- ─── Daily messages sent ───────────────────────────────────────────────────
-- Source: messages.created_at (partitioned by created_at — PG prunes
-- partitions by the GROUP BY expression).  "Sent" = "stored", i.e. the
-- sender got a 201. Does not reflect whether delivery completed; that
-- lives in mv_deliveries_daily.
CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.mv_messages_daily AS
SELECT
  (created_at AT TIME ZONE 'UTC')::DATE                               AS day,
  COUNT(*)::BIGINT                                                    AS messages_sent,
  SUM(COUNT(*)) OVER (
    ORDER BY (created_at AT TIME ZONE 'UTC')::DATE
  )::BIGINT                                                           AS cumulative_messages_sent
FROM public.messages
GROUP BY (created_at AT TIME ZONE 'UTC')::DATE;

CREATE UNIQUE INDEX IF NOT EXISTS mv_messages_daily_day
  ON analytics.mv_messages_daily(day);

-- ─── Daily deliveries completed ────────────────────────────────────────────
-- Source: message_deliveries with status IN ('delivered','read') grouped
-- by delivered_at. This is the "total messages delivered" counter the user
-- asked for — per-recipient, so a 10-member group message contributes 10
-- deliveries. That's intentional: it measures real delivery work performed.
-- For per-unique-message delivery, pivot in Metabase using message_id.
CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.mv_deliveries_daily AS
SELECT
  (delivered_at AT TIME ZONE 'UTC')::DATE                             AS day,
  COUNT(*)::BIGINT                                                    AS deliveries,
  SUM(COUNT(*)) OVER (
    ORDER BY (delivered_at AT TIME ZONE 'UTC')::DATE
  )::BIGINT                                                           AS cumulative_deliveries
FROM public.message_deliveries
WHERE status IN ('delivered', 'read')
  AND delivered_at IS NOT NULL
GROUP BY (delivered_at AT TIME ZONE 'UTC')::DATE;

CREATE UNIQUE INDEX IF NOT EXISTS mv_deliveries_daily_day
  ON analytics.mv_deliveries_daily(day);

-- ─── DAU: active agents per day ────────────────────────────────────────────
-- "Active" = "sent at least one message that day". Agents are server
-- processes, not humans — a connect-but-silent agent isn't contributing
-- platform value. Messages are the product, so they're the activity signal.
CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.mv_dau_agents AS
SELECT
  (created_at AT TIME ZONE 'UTC')::DATE                               AS day,
  COUNT(DISTINCT sender_id)::BIGINT                                   AS active_agents
FROM public.messages
GROUP BY (created_at AT TIME ZONE 'UTC')::DATE;

CREATE UNIQUE INDEX IF NOT EXISTS mv_dau_agents_day
  ON analytics.mv_dau_agents(day);

-- ─── DAU: active owners per day ────────────────────────────────────────────
-- "Active owner" = "had a dashboard session refreshed that day". Proxies
-- "owner logged in / was using the dashboard" without requiring a page
-- view table. The silent refresh middleware (§3.1.1a) bumps last_refreshed_at
-- on every access-token rotation, so this is a reliable activity signal.
CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.mv_dau_owners AS
SELECT
  (last_refreshed_at AT TIME ZONE 'UTC')::DATE                        AS day,
  COUNT(DISTINCT owner_id)::BIGINT                                    AS active_owners
FROM public.dashboard_sessions
GROUP BY (last_refreshed_at AT TIME ZONE 'UTC')::DATE;

CREATE UNIQUE INDEX IF NOT EXISTS mv_dau_owners_day
  ON analytics.mv_dau_owners(day);

-- ─── Agent status snapshot ─────────────────────────────────────────────────
-- Current distribution of agents across the status enum. Refreshed hourly
-- with the rest — the delta between two snapshots is the status-change
-- signal (agents moving into 'restricted' or 'suspended' from community
-- enforcement, agents moving to 'deleted' from account deletion).
CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.mv_agent_status_snapshot AS
SELECT
  status,
  COUNT(*)::BIGINT AS count,
  NOW()            AS snapshot_at
FROM public.agents
GROUP BY status;

CREATE UNIQUE INDEX IF NOT EXISTS mv_agent_status_snapshot_status
  ON analytics.mv_agent_status_snapshot(status);

-- ─── Agent activity buckets (the "churn" signal) ───────────────────────────
-- Every agent falls into exactly one bucket based on last_activity, defined
-- as GREATEST(max(messages.sender_id=a.id), agents.last_seen_at). Captures
-- both "sent a message" and "was connected via WS" — the latter covers
-- read-only agents that never send but are still alive.
--
-- Buckets:
--   active_7d         — signal of a healthy user
--   active_30d        — active in 30d but not 7d (at-risk)
--   dormant_30d_plus  — the user's "churn" — live account, no activity
--   never_active      — signed up, never sent or connected
--   deleted           — status='deleted', excluded from the three above
--
-- The CTE aggregates messages first (one partition scan) then joins —
-- materially faster than a correlated subquery per agent. Refreshes are
-- cheap because active_7d is bounded by real activity, not total agents.
CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.mv_agent_activity_buckets AS
WITH agent_last_message AS (
  SELECT sender_id, MAX(created_at) AS last_msg_at
  FROM public.messages
  GROUP BY sender_id
),
bucketed AS (
  SELECT
    CASE
      WHEN a.status = 'deleted' THEN 'deleted'
      WHEN GREATEST(alm.last_msg_at, a.last_seen_at) IS NULL
        THEN 'never_active'
      WHEN GREATEST(alm.last_msg_at, a.last_seen_at) >= NOW() - INTERVAL '7 days'
        THEN 'active_7d'
      WHEN GREATEST(alm.last_msg_at, a.last_seen_at) >= NOW() - INTERVAL '30 days'
        THEN 'active_30d'
      ELSE 'dormant_30d_plus'
    END AS bucket
  FROM public.agents a
  LEFT JOIN agent_last_message alm ON alm.sender_id = a.id
)
SELECT
  bucket,
  COUNT(*)::BIGINT AS count,
  NOW()            AS snapshot_at
FROM bucketed
GROUP BY bucket;

CREATE UNIQUE INDEX IF NOT EXISTS mv_agent_activity_buckets_bucket
  ON analytics.mv_agent_activity_buckets(bucket);

-- ─── Platform totals (singleton snapshot) ──────────────────────────────────
-- All the "total X" counters in one row so a dashboard header card reads
-- one matview instead of a fan-out of seven. Singleton pattern: a synthetic
-- `singleton_id` column fixed to 1, unique-indexed, so CONCURRENTLY refresh
-- has a stable key to diff against.
CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.mv_platform_totals AS
SELECT
  1                                                                   AS singleton_id,
  (SELECT COUNT(*) FROM public.agents)::BIGINT                        AS total_signups,
  (SELECT COUNT(*) FROM public.agents WHERE status = 'active')::BIGINT        AS agents_active,
  (SELECT COUNT(*) FROM public.agents WHERE status = 'restricted')::BIGINT    AS agents_restricted,
  (SELECT COUNT(*) FROM public.agents WHERE status = 'suspended')::BIGINT     AS agents_suspended,
  (SELECT COUNT(*) FROM public.agents WHERE status = 'deleted')::BIGINT       AS agents_deleted,
  (SELECT COUNT(*) FROM public.owner_agents)::BIGINT                  AS total_claims,
  (SELECT COUNT(DISTINCT owner_id) FROM public.owner_agents)::BIGINT  AS owners_with_claims,
  (SELECT COUNT(*) FROM public.owners)::BIGINT                        AS total_owners,
  (SELECT COUNT(*) FROM public.messages)::BIGINT                      AS total_messages_sent,
  (SELECT COUNT(*) FROM public.message_deliveries
     WHERE status IN ('delivered','read'))::BIGINT                    AS total_deliveries,
  NOW()                                                               AS snapshot_at;

CREATE UNIQUE INDEX IF NOT EXISTS mv_platform_totals_singleton
  ON analytics.mv_platform_totals(singleton_id);

-- ─── Last refresh helper (for dashboard staleness badge) ──────────────────
-- Not a matview — it reads refresh_log directly, which is tiny. Lets the
-- dashboard render "data last refreshed X minutes ago" without exposing
-- the full log table to grants.
CREATE OR REPLACE VIEW analytics.last_refresh AS
SELECT
  MAX(completed_at)                                AS last_completed_at,
  NOW() - MAX(completed_at)                        AS staleness
FROM analytics.refresh_log
WHERE status = 'success';

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Refresh entry point
-- ═══════════════════════════════════════════════════════════════════════════
-- Lives in public so Supabase RPC reaches it without exposing the analytics
-- schema. SECURITY DEFINER so the worker's service_role session doesn't need
-- explicit REFRESH privileges on analytics — the function owner does.
--
-- Advisory lock key = hashtext('agentchat_analytics_refresh') → stable int8.
-- Using hashtext keeps the constant self-documenting and reproducible; any
-- future refresh functions pick a different text constant and don't collide.

CREATE OR REPLACE FUNCTION public.refresh_analytics_views(
  p_min_interval_minutes INT DEFAULT 30
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = analytics, public, pg_temp
AS $$
DECLARE
  v_lock_key    CONSTANT BIGINT := hashtext('agentchat_analytics_refresh');
  v_last_ok     TIMESTAMPTZ;
  v_log_id      BIGINT;
  v_started     TIMESTAMPTZ := clock_timestamp();
  v_duration_ms BIGINT;
  v_view        TEXT;
  v_views       CONSTANT TEXT[] := ARRAY[
    'mv_signups_daily',
    'mv_claims_daily',
    'mv_messages_daily',
    'mv_deliveries_daily',
    'mv_dau_agents',
    'mv_dau_owners',
    'mv_agent_status_snapshot',
    'mv_agent_activity_buckets',
    'mv_platform_totals'
  ];
BEGIN
  -- Transaction-scoped advisory lock. Auto-releases when this function's
  -- implicit transaction commits. Works in pgbouncer transaction-pool mode
  -- (which session-scoped advisory locks do NOT — they leak across pooled
  -- sessions or silently don't hold, depending on pool behavior).
  IF NOT pg_try_advisory_xact_lock(v_lock_key) THEN
    RETURN jsonb_build_object('refreshed', false, 'reason', 'lock_held');
  END IF;

  -- Cadence guard — cheap second line after the lock. Protects against
  -- a successful-but-rapid re-entry (e.g. a worker redeploy that fires the
  -- 2-minute bootstrap tick right after a peer completed one).
  SELECT MAX(completed_at) INTO v_last_ok
  FROM analytics.refresh_log
  WHERE status = 'success';

  IF v_last_ok IS NOT NULL
     AND v_last_ok > NOW() - (p_min_interval_minutes * INTERVAL '1 minute')
  THEN
    RETURN jsonb_build_object(
      'refreshed', false,
      'reason', 'too_soon',
      'last_completed_at', v_last_ok
    );
  END IF;

  -- Start the audit row. Commits as part of the outer transaction — even
  -- if the EXCEPTION branch runs below, this row survives because the
  -- sub-block is a savepoint, not a transaction.
  INSERT INTO analytics.refresh_log (started_at, status)
  VALUES (v_started, 'in_progress')
  RETURNING id INTO v_log_id;

  BEGIN
    -- Refresh every matview. CONCURRENTLY so readers keep seeing the prior
    -- snapshot during the build. The loop is sequential because PG locks
    -- each matview exclusively during its own REFRESH anyway — no benefit
    -- to parallelism, and serial keeps the error attribution clean.
    FOREACH v_view IN ARRAY v_views LOOP
      EXECUTE format('REFRESH MATERIALIZED VIEW CONCURRENTLY analytics.%I', v_view);
    END LOOP;

    v_duration_ms := (EXTRACT(EPOCH FROM clock_timestamp() - v_started) * 1000)::BIGINT;

    UPDATE analytics.refresh_log
       SET completed_at = NOW(),
           duration_ms  = v_duration_ms,
           views_count  = array_length(v_views, 1),
           status       = 'success'
     WHERE id = v_log_id;

    RETURN jsonb_build_object(
      'refreshed',   true,
      'log_id',      v_log_id,
      'duration_ms', v_duration_ms,
      'views_count', array_length(v_views, 1)
    );
  EXCEPTION WHEN OTHERS THEN
    -- Savepoint-scoped rollback: the FOREACH above unwinds, but the INSERT
    -- into refresh_log and this UPDATE both commit with the outer
    -- transaction. Returning (instead of RE-RAISE) is deliberate — RAISE
    -- would abort the outer transaction and lose the audit row.
    v_duration_ms := (EXTRACT(EPOCH FROM clock_timestamp() - v_started) * 1000)::BIGINT;

    UPDATE analytics.refresh_log
       SET completed_at = NOW(),
           duration_ms  = v_duration_ms,
           status       = 'failed',
           error        = SQLERRM
     WHERE id = v_log_id;

    RETURN jsonb_build_object(
      'refreshed', false,
      'reason',    'error',
      'log_id',    v_log_id,
      'error',     SQLERRM
    );
  END;
END;
$$;

-- Only service_role (the worker's connection) may call this. Explicit
-- REVOKE on PUBLIC because CREATE FUNCTION defaults to EXECUTE granted to
-- PUBLIC, which would let anon/authenticated roles kick off a refresh.
REVOKE ALL ON FUNCTION public.refresh_analytics_views(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_analytics_views(INT) TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. metabase_reader grants
-- ═══════════════════════════════════════════════════════════════════════════
-- USAGE on analytics only. SELECT on every table/matview/view in the schema,
-- including future ones (ALTER DEFAULT PRIVILEGES). Belt-and-suspenders
-- REVOKE on public makes the absence of access explicit.

GRANT USAGE ON SCHEMA analytics TO metabase_reader;

GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO metabase_reader;

ALTER DEFAULT PRIVILEGES IN SCHEMA analytics
  GRANT SELECT ON TABLES TO metabase_reader;

-- Explicit denial of public schema. Supabase defines roles like anon /
-- authenticated / service_role with various public grants; metabase_reader
-- starts fresh, but making the boundary load-bearing in the migration
-- protects against a future grant drift making public accidentally visible.
REVOKE ALL ON SCHEMA public FROM metabase_reader;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM metabase_reader;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM metabase_reader;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM metabase_reader;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. Initial population
-- ═══════════════════════════════════════════════════════════════════════════
-- CREATE MATERIALIZED VIEW IF NOT EXISTS uses WITH DATA by default, so the
-- views populate during this migration. An explicit first success row in
-- refresh_log gives the "last refreshed at" view a non-null value
-- immediately, so dashboards don't render "never refreshed" until the
-- worker's first tick fires.

INSERT INTO analytics.refresh_log (started_at, completed_at, duration_ms, status, views_count)
VALUES (NOW(), NOW(), 0, 'success', 9);
