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
