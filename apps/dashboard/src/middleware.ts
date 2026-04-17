import { NextResponse, type NextRequest } from 'next/server'

// ─── Silent refresh middleware ─────────────────────────────────────────────
// Runs BEFORE every RSC render on a protected page. Proactively refreshes
// the dashboard access token when it's close to expiry so the browser never
// sees a 401 during normal use. Expired refresh token (or missing cookies)
// bounces the user to /login with both cookies cleared.
//
// Why in middleware and not in apiFetch:
//   RSCs (React Server Components) in Next.js 15 cannot call cookies().set()
//   during render — only Server Actions, Route Handlers, and middleware can
//   mutate cookies. If the refresh happened inside apiFetch, we could update
//   the browser cookie on the response, but downstream RSCs in the SAME
//   render pass would still see the old cookie value. Middleware runs first
//   and can rewrite the request headers so every RSC downstream sees the
//   fresh cookies as if they'd always been there.
//
// Refresh window:
//   The access token is a Supabase JWT with a 1h lifetime. We refresh when
//   it has LESS than 15 minutes left, so an active tab rotates at roughly
//   the 45-minute mark. The wide window ensures that even infrequent
//   requests (e.g. WS-triggered router.refresh() every ~40 min) catch
//   the token before it expires. Idle tabs with a still-valid access
//   token pass straight through without any API call.
//
// Failure mode:
//   If the api-server rejects the refresh (expired, revoked, or unknown),
//   we redirect to /login and clear both cookies on the response. The RSC
//   tree never runs for this request, so no stale owner data leaks.

const ACCESS_COOKIE = 'ac_dashboard_session'
const REFRESH_COOKIE = 'ac_dashboard_refresh'
const ACCESS_MAX_AGE = 60 * 60
const REFRESH_MAX_AGE = 60 * 60 * 24 * 30
const REFRESH_WINDOW_SECS = 15 * 60

const API_BASE = process.env['API_BASE'] ?? 'http://localhost:3000'

// Decode a JWT's `exp` claim without verifying the signature. Verification
// is the api-server's job — the middleware only needs to know whether the
// token is close to expiring so it can decide to refresh. A malformed or
// tampered token will fail upstream validation and we'll get a 401 there.
function getJwtExp(token: string): number | null {
  try {
    const payload = token.split('.')[1]
    if (!payload) return null
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    const decoded = JSON.parse(atob(padded)) as { exp?: number }
    return typeof decoded.exp === 'number' ? decoded.exp : null
  } catch {
    return null
  }
}

// Extract the value of a named cookie from one Set-Cookie header string.
// Set-Cookie format: `name=value; Path=/; HttpOnly; ...`. We only care
// about the name=value pair because we re-set with our own attributes.
function extractCookieValue(setCookie: string, name: string): string | null {
  const firstPart = setCookie.split(';')[0]
  if (!firstPart) return null
  const eq = firstPart.indexOf('=')
  if (eq === -1) return null
  const cookieName = firstPart.slice(0, eq).trim()
  if (cookieName !== name) return null
  return firstPart.slice(eq + 1).trim()
}

function extractCookieFromHeaders(headers: Headers, name: string): string | null {
  // getSetCookie() returns an array of individual Set-Cookie strings in
  // Node 18+ and Edge runtime. If a runtime flattens multiple Set-Cookie
  // headers into a single comma-joined string, .get('set-cookie') would
  // be ambiguous — getSetCookie() avoids that foot-gun.
  const cookies = headers.getSetCookie?.() ?? []
  for (const c of cookies) {
    const v = extractCookieValue(c, name)
    if (v !== null) return v
  }
  return null
}

function redirectToLogin(req: NextRequest): NextResponse {
  const loginUrl = new URL('/login', req.url)
  const res = NextResponse.redirect(loginUrl)
  res.cookies.delete(ACCESS_COOKIE)
  res.cookies.delete(REFRESH_COOKIE)
  return res
}

export async function middleware(req: NextRequest) {
  const access = req.cookies.get(ACCESS_COOKIE)?.value
  const refresh = req.cookies.get(REFRESH_COOKIE)?.value

  // No cookies at all → user is signed out. Let the request through so
  // the RSC's apiFetch sees a 401 and handles the redirect itself. We
  // could redirect here too, but letting apiFetch own the kick-to-login
  // keeps one code path for "session failed mid-render".
  if (!access && !refresh) {
    return NextResponse.next()
  }

  // Access token still has plenty of runway → pass through, no refresh.
  // Re-stamp both cookies with explicit maxAge on every pass-through so
  // they are always persistent. The initial login sets cookies through the
  // Vercel rewrite proxy (Next config rewrites /dashboard/* → api-server),
  // and the proxy may not forward the Max-Age attribute — the browser then
  // treats them as session cookies that die on window close. Re-stamping
  // here upgrades them to persistent cookies on the very first navigation
  // after login, which is invisible to the user.
  if (access) {
    const exp = getJwtExp(access)
    const now = Math.floor(Date.now() / 1000)
    if (exp && exp - now > REFRESH_WINDOW_SECS) {
      const response = NextResponse.next()
      const secure = process.env.NODE_ENV === 'production'
      response.cookies.set(ACCESS_COOKIE, access, {
        httpOnly: true,
        secure,
        sameSite: 'lax',
        path: '/',
        maxAge: exp - now,
      })
      if (refresh) {
        response.cookies.set(REFRESH_COOKIE, refresh, {
          httpOnly: true,
          secure,
          sameSite: 'lax',
          path: '/',
          maxAge: REFRESH_MAX_AGE,
        })
      }
      return response
    }
  }

  // Access token is expired/expiring OR only the refresh cookie is
  // present (e.g. the access cookie hit its maxAge and got evicted by
  // the browser). Try to refresh.
  if (!refresh) {
    return redirectToLogin(req)
  }

  // Only a real 401/403 from the api-server counts as auth death. Any
  // other failure (network error, 5xx, refresh coordinator timeout) means
  // we don't know — fall through with the existing cookies and let the
  // RSC's apiFetch see the real state. Kicking the user out on a transient
  // blip is worse than one failed request.
  let refreshRes: Response
  try {
    refreshRes = await fetch(`${API_BASE}/dashboard/auth/refresh`, {
      method: 'POST',
      headers: {
        cookie: `${REFRESH_COOKIE}=${refresh}`,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
    })
  } catch {
    return NextResponse.next()
  }

  if (refreshRes.status === 401 || refreshRes.status === 403) {
    return redirectToLogin(req)
  }

  if (!refreshRes.ok) {
    return NextResponse.next()
  }

  const newAccess = extractCookieFromHeaders(refreshRes.headers, ACCESS_COOKIE)
  const newRefresh = extractCookieFromHeaders(refreshRes.headers, REFRESH_COOKIE)
  if (!newAccess || !newRefresh) {
    return NextResponse.next()
  }

  // Rewrite the forwarded Cookie header so downstream RSCs reading
  // cookies() in this same request see the fresh values. Without this
  // they'd still see the pre-refresh cookies from the incoming request.
  const forwardedHeaders = new Headers(req.headers)
  forwardedHeaders.set(
    'cookie',
    `${ACCESS_COOKIE}=${newAccess}; ${REFRESH_COOKIE}=${newRefresh}`,
  )

  const response = NextResponse.next({
    request: { headers: forwardedHeaders },
  })

  const secure = process.env.NODE_ENV === 'production'
  response.cookies.set(ACCESS_COOKIE, newAccess, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: ACCESS_MAX_AGE,
  })
  response.cookies.set(REFRESH_COOKIE, newRefresh, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: REFRESH_MAX_AGE,
  })

  return response
}

// Skip the middleware on paths where it would be pointless or harmful:
//   login      — the only unauthenticated surface, must stay reachable
//   dashboard  — API proxy paths (next.config.ts rewrite → api-server);
//                those are authenticated at the api-server, not here
//   _next/*    — Next.js static assets and image optimizer
//   favicon.ico etc. — static files
export const config = {
  matcher: [
    '/((?!login|dashboard|_next/static|_next/image|favicon.ico).*)',
  ],
}
