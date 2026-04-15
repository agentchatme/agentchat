import { createMiddleware } from 'hono/factory'

// ─── Server-Timing middleware ──────────────────────────────────────────────
// Emits a Server-Timing response header that Chrome DevTools (and most
// modern observability tools) render inline in the Network tab. This is
// the fastest way to tell, on any production request, how much of the
// wall-clock time was spent in auth vs. in database/handler work — no
// APM agent, no log ingestion, no deploy.
//
// Header format:
//   Server-Timing: auth;dur=<ms>, db;dur=<ms>, total;dur=<ms>
//
// `total` is measured here (wall clock from middleware entry to response
// flush). `auth` is measured by dashboardAuthMiddleware and stashed on
// the context as `authDurationMs`. `db` is derived as total - auth so it
// captures every millisecond the handler spent outside auth — query
// time, serialization, framework overhead — without requiring manual
// annotation of each handler. For routes that don't run the auth
// middleware (e.g. /dashboard/auth/otp/request), auth is omitted and
// `db` equals `total`.
//
// Security:
//   * Server-Timing is a public response header exposed to the browser.
//     Only non-sensitive counters are emitted — no phase names that leak
//     internal services (no "supabase", "redis", "postgres", no query
//     identifiers). "auth" and "db" are the same abstractions the plan
//     file uses publicly in §12 perf budgets.
//   * Values are integer milliseconds. Sub-ms precision is NOT emitted
//     because a determined attacker could use high-precision timing to
//     probe for things like password-comparison side channels — though
//     our auth path does not branch on secret data, the defense-in-depth
//     cost of rounding to ms is zero.
//   * If response-header mutation has already been locked (e.g. an
//     early 101/204), we silently skip the header rather than throwing.

type TimingEnv = {
  Variables: {
    // Set by dashboardAuthMiddleware when it completes. Undefined for
    // endpoints that skip auth (unauth'd OTP routes).
    authDurationMs?: number
  }
}

export const serverTimingMiddleware = createMiddleware<TimingEnv>(async (c, next) => {
  const startNs = process.hrtime.bigint()

  try {
    await next()
  } finally {
    // Even on a thrown error we still want to record the timing so
    // Server-Timing covers failed requests — they're the most
    // interesting ones to observe in DevTools. Hono's error-handler
    // middleware converts thrown errors into Response objects before
    // this finally runs, so c.res is set either way.
    const totalMs = Number((process.hrtime.bigint() - startNs) / 1_000_000n)
    const authMs = c.get('authDurationMs')
    const dbMs = authMs !== undefined ? Math.max(0, totalMs - authMs) : totalMs

    const parts: string[] = []
    if (authMs !== undefined) parts.push(`auth;dur=${authMs}`)
    parts.push(`db;dur=${dbMs}`)
    parts.push(`total;dur=${totalMs}`)

    try {
      c.res.headers.set('Server-Timing', parts.join(', '))
    } catch {
      // Header already frozen (e.g. streamed response); nothing to do.
    }
  }
})
