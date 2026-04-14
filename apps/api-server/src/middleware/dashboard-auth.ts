import { createMiddleware } from 'hono/factory'
import { getCookie } from 'hono/cookie'
import { findOwnerById, getSupabaseClient } from '@agentchat/db'

// ─── Dashboard auth middleware ─────────────────────────────────────────────
// Reads the httpOnly session cookie set during /dashboard/auth/otp/verify,
// validates the JWT against Supabase, and loads the matching owners row.
// Sets `ownerId` + `owner` on the context so downstream routes can scope
// every read/write to the caller's own claimed agents.
//
// Cookie contract (documented once so route code can stay consistent):
//   name:       ac_dashboard_session
//   value:      Supabase access_token (JWT) from verifyOtp()
//   attributes: HttpOnly, Secure (in prod), SameSite=Lax, Path=/
//   lifetime:   matches the Supabase access_token TTL (default 1h). When
//               the token expires, the middleware surfaces 401 and the
//               frontend re-OTPs. We intentionally do NOT carry a refresh
//               token for Phase D1 — simpler cookie surface, and a
//               short-session lurker dashboard is acceptable.
//
// Error responses:
//   401 UNAUTHORIZED — no cookie or token failed validation
//   401 OWNER_NOT_FOUND — valid JWT but no matching owners row (soft-deleted
//   or never created, e.g. a stale cookie that outlived the account)

export const DASHBOARD_SESSION_COOKIE = 'ac_dashboard_session'

type DashboardEnv = {
  Variables: {
    ownerId: string
    owner: NonNullable<Awaited<ReturnType<typeof findOwnerById>>>
  }
}

export const dashboardAuthMiddleware = createMiddleware<DashboardEnv>(async (c, next) => {
  const token = getCookie(c, DASHBOARD_SESSION_COOKIE)
  if (!token) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Not signed in' }, 401)
  }

  // Validate the JWT against Supabase. getUser() with an explicit token
  // makes a stateless REST call to the auth endpoint — it does NOT mutate
  // the service-role client's in-memory session, which would otherwise
  // poison every subsequent service-role call on this process.
  const supabase = getSupabaseClient()
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Session expired' }, 401)
  }

  const owner = await findOwnerById(data.user.id)
  if (!owner) {
    return c.json({ code: 'OWNER_NOT_FOUND', message: 'Owner account not found' }, 401)
  }

  c.set('ownerId', owner.id)
  c.set('owner', owner)
  return next()
})
