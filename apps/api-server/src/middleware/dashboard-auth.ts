import { createMiddleware } from 'hono/factory'
import { getCookie } from 'hono/cookie'
import { jwtVerify } from 'jose'
import { findOwnerById } from '@agentchat/db'
import { env } from '../env.js'

// ─── Dashboard auth middleware ─────────────────────────────────────────────
// Reads the httpOnly session cookie set during /dashboard/auth/otp/verify,
// verifies the JWT LOCALLY against SUPABASE_JWT_SECRET, and loads the
// matching owners row. Sets `ownerId` + `owner` on the context so
// downstream routes can scope every read/write to the caller's own
// claimed agents.
//
// Performance: local verify is ~1ms vs ~80-150ms for a network call to
// supabase.auth.getUser() (which is what this middleware used to do).
// This middleware runs on every /dashboard/* request, so the savings
// multiply across the handful of fetches each page navigation triggers.
// That's a huge chunk of the dashboard click-latency budget, reclaimed.
//
// Why local verify is safe:
//   * Supabase mints access tokens signed with SUPABASE_JWT_SECRET (HS256
//     by default). Any token that verifies AND is not expired AND carries
//     the right issuer/audience is a token Supabase itself issued.
//   * Revocation is bounded by two things: (a) 1h access token TTL
//     naturally kills stale tokens; (b) sign-out-everywhere DELETEs the
//     matching dashboard_sessions row which kills refresh capability, so
//     even a stolen access token expires within 1h and cannot be renewed.
//   * Supabase's own getUser() endpoint does the same signature check and
//     does NOT consult a server-side revocation list for access tokens,
//     so running the check locally is functionally equivalent.
//
// Cookie contract (unchanged from the old network-verify path):
//   ac_dashboard_session — short-lived access token (Supabase JWT, 1h TTL)
//     Presented on every /dashboard/* request. Verified here via
//     jose.jwtVerify(token, secret).
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
//   401 UNAUTHORIZED — no cookie, failed verify, or missing sub claim
//   401 OWNER_NOT_FOUND — valid JWT but no matching owners row (soft-deleted
//   or never created, e.g. a stale cookie that outlived the account)

export const DASHBOARD_SESSION_COOKIE = 'ac_dashboard_session'
export const DASHBOARD_REFRESH_COOKIE = 'ac_dashboard_refresh'

// Cookie lifetimes, in seconds. Access cookie matches the Supabase JWT
// default (1h) so local verify never rejects a cookie we still think is
// live. Refresh cookie is 30 days — the outer bound on how long an idle
// tab can sit before the user has to re-OTP. Rotation on every refresh
// means continuously-used sessions never hit this ceiling.
export const DASHBOARD_ACCESS_COOKIE_MAX_AGE = 60 * 60
export const DASHBOARD_REFRESH_COOKIE_MAX_AGE = 60 * 60 * 24 * 30

// Prepared once at module load: raw-bytes view of SUPABASE_JWT_SECRET so
// every request reuses it (jose needs the raw key, not the string). The
// issuer/audience constants derive from env and stay frozen for the
// process lifetime, so there is no per-request allocation on the hot
// auth path.
const JWT_SECRET_BYTES = new TextEncoder().encode(env.SUPABASE_JWT_SECRET)
const JWT_ISSUER = `${env.SUPABASE_URL}/auth/v1`
const JWT_AUDIENCE = 'authenticated'

type DashboardEnv = {
  Variables: {
    ownerId: string
    owner: NonNullable<Awaited<ReturnType<typeof findOwnerById>>>
    // Populated on every auth-middleware run (success or 401 short-
    // circuit) so the Server-Timing middleware can split wall-clock
    // into auth vs. db phases. Integer milliseconds.
    authDurationMs: number
  }
}

export const dashboardAuthMiddleware = createMiddleware<DashboardEnv>(async (c, next) => {
  const authStart = process.hrtime.bigint()
  const recordAuthTiming = () => {
    const dur = Number((process.hrtime.bigint() - authStart) / 1_000_000n)
    c.set('authDurationMs', dur)
  }

  const token = getCookie(c, DASHBOARD_SESSION_COOKIE)
  if (!token) {
    recordAuthTiming()
    return c.json({ code: 'UNAUTHORIZED', message: 'Not signed in' }, 401)
  }

  // Local HS256 verify. jose enforces, in one pass:
  //   * signature via JWT_SECRET_BYTES (wrong or missing secret → throw)
  //   * alg ∈ ['HS256'] — this REJECTS forged "alg: none" tokens and
  //     stops algorithm-confusion attacks where an attacker re-signs
  //     with a public key as HMAC input
  //   * exp/nbf/iat with 30s default clock skew
  //   * issuer and audience claims match the values we pass
  let sub: string | undefined
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET_BYTES, {
      algorithms: ['HS256'],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    })
    sub = typeof payload.sub === 'string' ? payload.sub : undefined
  } catch {
    // Do NOT log the raw token, the jose error message, or the payload.
    // All three can leak base64-decoded claims to log aggregators. The
    // Next.js middleware catches this 401 and triggers silent refresh;
    // the user only hits /login if BOTH the access cookie AND the
    // refresh cookie are missing or rejected.
    recordAuthTiming()
    return c.json({ code: 'UNAUTHORIZED', message: 'Session expired' }, 401)
  }

  if (!sub) {
    recordAuthTiming()
    return c.json({ code: 'UNAUTHORIZED', message: 'Session expired' }, 401)
  }

  const owner = await findOwnerById(sub)
  if (!owner) {
    recordAuthTiming()
    return c.json({ code: 'OWNER_NOT_FOUND', message: 'Owner account not found' }, 401)
  }

  c.set('ownerId', owner.id)
  c.set('owner', owner)
  recordAuthTiming()
  return next()
})
