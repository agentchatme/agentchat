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

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: '/dashboard/:path*',
        destination: `${apiBase}/dashboard/:path*`,
      },
    ]
  },
}

export default nextConfig
