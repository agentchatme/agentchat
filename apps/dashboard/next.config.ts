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
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
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
  // Raising `dynamic` to 300s turns the router cache into a warm
  // cache for ~5 minutes per route segment. Clicking Bob → Carol →
  // back to Bob inside 5 min serves Bob's full page (layout + RSC
  // + messages) from the in-memory client cache with zero network,
  // zero server render, zero paint delay. That is the WhatsApp-like
  // behavior the dashboard is missing today: after the first visit
  // a thread is "warm" and feels instant on revisit.
  //
  // `static` at 300s keeps static segments (the agent-workspace
  // layout chrome) cached for the same window so the chat header
  // never refetches when the handle is unchanged.
  //
  // Live updates (new-message-arrived-while-you-were-elsewhere) are
  // a follow-up: the dashboard will subscribe to the api-server's
  // WebSocket and call router.refresh() on `message.new` events to
  // invalidate the cache entry for the affected thread. Until then,
  // the worst-case staleness is 5 minutes, which is acceptable for
  // a read-only lurker view — and the owner can always hit the
  // browser reload to force-refresh.
  experimental: {
    staleTimes: {
      dynamic: 300,
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
