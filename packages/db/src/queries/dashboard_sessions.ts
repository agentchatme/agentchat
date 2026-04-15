import { getSupabaseClient } from '../client.js'

// ─── Dashboard sessions ────────────────────────────────────────────────────
// One row per active browser session for an owner. The refresh token itself
// never lives on the server — only its SHA-256 hash — so a DB read leak
// cannot be replayed against Supabase, and rotation/sign-out are simple row
// operations scoped to `owner_id` and `refresh_token_hash`.
//
// The refresh path (POST /dashboard/auth/refresh) looks up by hash, asks
// Supabase for a new token pair, and calls `rotateDashboardSession` with
// the new hash on the same row. Sign-out-everywhere (POST /dashboard/auth/
// logout?scope=all) is a single `deleteDashboardSessionsForOwner` call.
//
// We deliberately do NOT store access tokens or an `expires_at`. Access
// tokens live only in the browser cookie (1h TTL), and the refresh token's
// expiry is enforced by Supabase itself when we call it — a row whose token
// has expired just returns an error on refresh, at which point the caller
// deletes the row and re-OTPs.

export interface DashboardSession {
  id: string
  owner_id: string
  refresh_token_hash: string
  created_at: string
  last_refreshed_at: string
}

export async function insertDashboardSession(params: {
  id: string
  owner_id: string
  refresh_token_hash: string
}): Promise<DashboardSession> {
  const { data, error } = await getSupabaseClient()
    .from('dashboard_sessions')
    .insert({
      id: params.id,
      owner_id: params.owner_id,
      refresh_token_hash: params.refresh_token_hash,
    })
    .select()
    .single()

  if (error) throw error
  return data as DashboardSession
}

/**
 * Look up a session by the SHA-256 hash of its refresh token. Used by the
 * refresh endpoint to validate the incoming cookie before calling Supabase.
 * Returns null on miss so the caller can surface a clean 401.
 */
export async function findDashboardSessionByHash(
  refresh_token_hash: string,
): Promise<DashboardSession | null> {
  const { data, error } = await getSupabaseClient()
    .from('dashboard_sessions')
    .select('*')
    .eq('refresh_token_hash', refresh_token_hash)
    .single()
  if (error) return null
  return data as DashboardSession
}

/**
 * Rotate the refresh token on an existing session row. Matched on the OLD
 * hash so two concurrent refresh attempts from different tabs can only
 * succeed once — the loser's UPDATE affects zero rows and the caller
 * surfaces a 401 that forces a re-OTP on that tab. Low probability in
 * practice; documented tradeoff rather than fixing with a second lock.
 */
export async function rotateDashboardSession(params: {
  old_hash: string
  new_hash: string
}): Promise<DashboardSession | null> {
  const { data, error } = await getSupabaseClient()
    .from('dashboard_sessions')
    .update({
      refresh_token_hash: params.new_hash,
      last_refreshed_at: new Date().toISOString(),
    })
    .eq('refresh_token_hash', params.old_hash)
    .select()
    .single()
  if (error) return null
  return data as DashboardSession
}

/**
 * Single-session logout: delete the row whose refresh token hash matches
 * the cookie the browser presented. Idempotent — a missing row is fine.
 */
export async function deleteDashboardSessionByHash(
  refresh_token_hash: string,
): Promise<void> {
  const { error } = await getSupabaseClient()
    .from('dashboard_sessions')
    .delete()
    .eq('refresh_token_hash', refresh_token_hash)
  if (error) throw error
}

/**
 * Sign-out-everywhere: drop every session row for one owner. Returns the
 * row count so the caller can include it in the response for UX (e.g.
 * "signed out of 3 devices"). The browser that initiated the action also
 * deletes its own cookies — the row deletion handles the server side.
 */
export async function deleteDashboardSessionsForOwner(
  owner_id: string,
): Promise<number> {
  const { error, count } = await getSupabaseClient()
    .from('dashboard_sessions')
    .delete({ count: 'exact' })
    .eq('owner_id', owner_id)
  if (error) throw error
  return count ?? 0
}
