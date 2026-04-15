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
//   ac_dashboard_session — short-lived access token (Supabase JWT, 1h TTL)
//     Presented on every /dashboard/* request. Validated here via a
//     stateless supabase.auth.getUser(token) call.
//   ac_dashboard_refresh — long-lived refresh token (30d TTL)
//     Never touched by this middleware. Only the /dashboard/auth/refresh
//     route reads it; the dashboard's Next.js middleware proactively
//     calls that route when the access token is close to expiry so the
//     browser never sees a 401 during normal use.
//
// Both cookies are HttpOnly + Secure (prod) + SameSite=Lax + Path=/. The
// access cookie returning 401 does NOT mean the session is dead — the
// Next.js middleware catches it and silently refreshes using the refresh
// cookie. A user only gets bounced to /login when BOTH the access cookie
// AND the refresh cookie are missing or the refresh call itself is
// rejected by Supabase (true logout, or 30d idle).
//
// Error responses:
//   401 UNAUTHORIZED — no cookie or access token failed validation
//   401 OWNER_NOT_FOUND — valid JWT but no matching owners row (soft-deleted
//   or never created, e.g. a stale cookie that outlived the account)

export const DASHBOARD_SESSION_COOKIE = 'ac_dashboard_session'
export const DASHBOARD_REFRESH_COOKIE = 'ac_dashboard_refresh'

// Cookie lifetimes, in seconds. Access cookie matches the Supabase JWT
// default (1h) so `getUser(token)` never rejects a cookie we still think
// is live. Refresh cookie is 30 days — the outer bound on how long an
// idle tab can sit before the user has to re-OTP. Rotation on every
// refresh means continuously-used sessions never hit this ceiling.
export const DASHBOARD_ACCESS_COOKIE_MAX_AGE = 60 * 60
export const DASHBOARD_REFRESH_COOKIE_MAX_AGE = 60 * 60 * 24 * 30

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
