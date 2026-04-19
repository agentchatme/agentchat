import { getSupabaseClient } from '../client.js'

// ─── Analytics refresh RPC (migration 042) ─────────────────────────────────
//
// Thin typed wrapper around `public.refresh_analytics_views(p_min_interval_minutes)`.
// The SQL function returns a JSONB discriminated union keyed on either the
// `refreshed` boolean (success path) or `refreshed`=false + `reason` (skip
// or failure path). Shaping it as a TypeScript union here forces every caller
// to handle the skip reasons before observing duration — missing branches
// become compile errors instead of silent "undefined" dashboards.
//
// Contract (must match migration 042 refresh_analytics_views):
//
//   success:
//     { refreshed: true, log_id: number, duration_ms: number, views_count: number }
//
//   skipped — another worker is holding the transaction-scoped advisory lock:
//     { refreshed: false, reason: 'lock_held' }
//
//   skipped — cadence guard tripped (last success < min_interval_minutes ago):
//     { refreshed: false, reason: 'too_soon', last_completed_at: string }
//
//   failed — REFRESH MATERIALIZED VIEW raised inside the savepoint block;
//   the audit row is written before we return so ops can drain refresh_log:
//     { refreshed: false, reason: 'error', log_id: number, error: string }
//
// The SQL function NEVER raises — even on refresh failure it commits the
// audit row and returns the `error` variant. That means a thrown error from
// this wrapper is always a client-side or transport failure (auth, network,
// JSON shape mismatch), never an in-function refresh error. Callers can
// distinguish "the refresh failed" (returned shape) from "we couldn't reach
// Postgres" (thrown).

export type AnalyticsRefreshResult =
  | {
      refreshed: true
      log_id: number
      duration_ms: number
      views_count: number
    }
  | { refreshed: false; reason: 'lock_held' }
  | {
      refreshed: false
      reason: 'too_soon'
      last_completed_at: string
    }
  | {
      refreshed: false
      reason: 'error'
      log_id: number
      error: string
    }

/**
 * Invoke the analytics refresh RPC. `minIntervalMinutes` is the cadence
 * guard: if the last successful refresh was newer than that, the function
 * returns `too_soon` without touching the matviews. The worker passes a
 * value slightly below its own tick interval so a restart-triggered
 * bootstrap tick doesn't double-refresh on top of the most recent one.
 *
 * Throws on transport/shape errors (network, auth, unexpected JSON). Returns
 * the typed union for every in-function outcome, including refresh failures.
 */
export async function refreshAnalyticsViews(
  minIntervalMinutes = 30,
): Promise<AnalyticsRefreshResult> {
  const { data, error } = await getSupabaseClient().rpc(
    'refresh_analytics_views',
    { p_min_interval_minutes: minIntervalMinutes },
  )
  if (error) throw error
  if (!data || typeof data !== 'object') {
    throw new Error(
      `refresh_analytics_views returned non-object: ${JSON.stringify(data)}`,
    )
  }
  // The SQL function's output is the source of truth — trust its shape and
  // let TypeScript narrow on `refreshed` / `reason`. Any drift from the
  // contract above is a migration-level bug, not something we patch here.
  return data as AnalyticsRefreshResult
}
