-- Migration 033: Enable retention on messages + message_deliveries partitions.
-- ==========================================================================
-- BEFORE:
--   migration 028 bootstrapped pg_partman on both tables with
--   `retention = NULL`, i.e. "keep every month forever." That was correct
--   for launch (no production data to age out), but the TODO was to flip
--   it on once we'd picked a retention window. At ~1M agents × ~10
--   msg/day, a year is ~3.6B rows per table — without retention the
--   planner eventually pays the price for every query even with partition
--   pruning, and disk growth compounds monthly.
--
-- AFTER:
--   retention = 12 months, retention_keep_table = false. When
--   extensions.run_maintenance_proc() runs (scheduled via pg_cron per
--   migration 028 lines 386-401), partitions older than 12 months are
--   detached and dropped in a single transaction. Rows inside aged-out
--   partitions become inaccessible — there is NO soft-delete; the
--   partition file is removed from the filesystem by the DROP.
--
-- Why 12 months (not 6, not 24):
--   * Chargeback / billing windows in financial jurisdictions top out
--     around 6 months; doubling gives comfort that an accounting dispute
--     raised on day 179 has full message history to reconcile against.
--   * Support / debugging: operator incidents we've investigated in
--     internal use so far reached back at most ~3 weeks. 12 months covers
--     the long tail by 4×.
--   * Legal discovery: subpoena / preservation-order windows commonly land
--     in the 6–12 month range for messaging products. We err on the side
--     of not-enough rather than more, because retention creates liability
--     as much as it satisfies it — messages we don't have are messages
--     that don't show up in a discovery order.
--   * Anti-abuse investigations: block + report state already lives in
--     dedicated tables with their own retention. Keeping the raw message
--     body past 12 months adds exposure without adding forensic value.
--   * Storage: monthly partition drops level off disk growth at roughly
--     12 × steady-month size. Without retention this grows linearly
--     forever; with 12 months we eventually hit a plateau.
--
-- Note: this migration does NOT drop any partitions on its own. It only
-- updates the pg_partman configuration row. The next scheduled
-- run_maintenance_proc() tick (04:00 UTC daily per migration 028's
-- recommendation) picks up the new value and acts on it. Operators can
-- force a sweep with `CALL extensions.run_maintenance_proc();` if they
-- want immediate effect.
--
-- Prerequisite: the pg_cron job documented at migration 028 lines 386-401
-- MUST be running for retention to actually fire. Without it this
-- migration is a no-op config change — partitions will accumulate exactly
-- as before. The migration is still safe to apply (idempotent UPDATE), but
-- ops needs to confirm the cron job is live separately.

-- Sanity check — both rows exist (they were created by migration 028's
-- create_parent calls). If they don't, either 028 didn't run or someone
-- deleted the config, and we should fail loudly rather than silently
-- no-op this migration.
DO $$
DECLARE
  v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM extensions.part_config
  WHERE parent_table IN ('public.messages', 'public.message_deliveries');

  IF v_count < 2 THEN
    RAISE EXCEPTION 'Expected 2 pg_partman config rows (messages + message_deliveries), found %. Did migration 028 run?', v_count;
  END IF;
END $$;

-- Apply the retention policy. 12 months interval stored as text because
-- part_config.retention is TEXT, not INTERVAL (pg_partman accepts either
-- INTERVAL-like strings or explicit TEXT in that column — see partman
-- docs). retention_keep_table = false means "when a partition ages out,
-- DROP the partition entirely" — the alternative (true) just detaches,
-- which means the data is still on disk under a different (inaccessible)
-- name. We want the disk space back.
UPDATE extensions.part_config
SET retention = '12 months',
    retention_keep_table = false,
    -- retention_keep_index is about detached-but-kept tables — irrelevant
    -- when retention_keep_table=false. Leaving it at its default.
    infinite_time_partitions = true
WHERE parent_table IN ('public.messages', 'public.message_deliveries');

-- Post-hoc verification. If the UPDATE above didn't touch exactly 2 rows,
-- something's wrong (one of the two rows got deleted between the DO $$
-- block and the UPDATE, or the config row shape changed in a pg_partman
-- upgrade). Fail so the operator sees it instead of silently under-
-- configuring.
DO $$
DECLARE
  v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM extensions.part_config
  WHERE parent_table IN ('public.messages', 'public.message_deliveries')
    AND retention = '12 months'
    AND retention_keep_table = false;

  IF v_count <> 2 THEN
    RAISE EXCEPTION 'Retention config update affected % rows, expected 2', v_count;
  END IF;

  RAISE NOTICE 'Partition retention configured: 12 months, drop on age-out (messages + message_deliveries)';
END $$;
