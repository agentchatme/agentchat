import type { NextConfig } from 'next'

// The dashboard runs on its own Next process (default port 3001 in dev
// when API occupies 3000). Every /dashboard/* request is proxied through
// to the API server so the browser sees one origin for both UI and auth.
// That way:
//   - The ac_dashboard_session cookie is strictly same-origin and can stay
//     SameSite=Lax + Secure without cross-site headaches.
//   - Client components can fetch('/dashboard/...') directly, with cookies
//     automatically attached by the browser.
//   - Server components can call the API_BASE directly and forward the
//     incoming cookie via the `lib/api` helper (see src/lib/api.ts).
//
// Production deployment collapses this: dashboard runs on app.agentchat.me
// and API on api.agentchat.me, with an upstream proxy (Vercel rewrites
// already cover this pattern) unifying them under one origin. For Phase
// D1 local dev, the rewrite below is enough.

const apiBase = process.env['API_BASE'] ?? 'http://localhost:3000'
const wsUrl = process.env['NEXT_PUBLIC_WS_URL'] ?? ''
const isProd = process.env.NODE_ENV === 'production'

// Hardened security headers applied to every dashboard response. The
// dashboard is browser-facing so each header here mitigates a specific
// class of attack:
//
//   Strict-Transport-Security: forces HTTPS for a year + preload — set
//     only in prod because dev runs over localhost http.
//   X-Frame-Options + frame-ancestors 'none': defense-in-depth against
//     clickjacking. The CSP directive is the modern enforcement; XFO is
//     kept as a fallback for old browsers / WebView contexts.
//   X-Content-Type-Options: prevents MIME-type sniffing — blocks the
//     'image actually executes as JS' style of attack on user uploads.
//   Referrer-Policy: don't leak the dashboard's URL to outbound links.
//   Permissions-Policy: explicitly disable browser features the dashboard
//     never asks for (camera, mic, geolocation, payment) so a future XSS
//     cannot exfiltrate over those channels.
//   CSP: tightest practical for a Next.js 15 RSC app. We allow inline
//     scripts/styles because Next's bootstrap requires it without nonces;
//     adding nonce-based CSP is a follow-up that needs a middleware.
//     connect-src is 'self' because the API is same-origin via the rewrite
//     above. frame-ancestors 'none' kills any iframe embedding.
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://*.supabase.co",
      "font-src 'self' data:",
      `connect-src 'self'${wsUrl ? ` ${wsUrl}` : ''}`,
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '),
  },
  ...(isProd
    ? [
        {
          key: 'Strict-Transport-Security',
          value: 'max-age=31536000; includeSubDomains; preload',
        },
      ]
    : []),
]

const nextConfig: NextConfig = {
  // Client-side router cache. Next 15 defaults dynamic-page staleTime
  // to 0, which means every navigation re-fetches the RSC payload
  // from scratch — including re-running server components and all
  // their data fetches. For a chat dashboard where the owner flips
  // between the same 2–4 recent threads repeatedly, that is the
  // difference between a ~300ms click and a 0ms click.
  //
  // `dynamic: 30` is the rapid-flip sweet spot: clicking Bob → Carol
  // → back to Bob inside 30s hits the warm router cache (zero network,
  // zero server render), while bounding the worst-case stale-on-
  // revisit window to 30s for a cached-but-not-active thread. Live
  // updates for the ACTIVE view come from the WS provider — it calls
  // router.refresh() on message.new, which invalidates whichever
  // segment is currently rendered. The 30s cap only matters for
  // threads you haven't opened recently: after 30s the cache expires
  // and the next click does a fresh fetch anyway.
  //
  // Why 30 instead of 0: zero would throw away the rapid-flip win
  // (the whole reason staleTimes exists) and spam the api-server on
  // every back/forward. 30s keeps the flip-warm behavior without
  // risking stale data lingering longer than a human would notice.
  //
  // `static` at 300s keeps static segments (the agent-workspace
  // layout chrome) cached for the same window so the chat header
  // never refetches when the handle is unchanged.
  experimental: {
    staleTimes: {
      dynamic: 30,
      static: 300,
    },
  },
  async rewrites() {
    return [
      {
        source: '/dashboard/:path*',
        destination: `${apiBase}/dashboard/:path*`,
      },
    ]
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
    ]
  },
}

export default nextConfig
