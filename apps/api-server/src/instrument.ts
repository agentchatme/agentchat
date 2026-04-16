// Sentry initialization. MUST be imported as the very first line of any
// process entry point (api-server's index.ts, the webhook worker's worker.ts)
// so the SDK can wrap node internals before user code starts allocating
// async contexts. The @sentry/node v8 SDK relies on AsyncLocalStorage hooks
// installed at init time — late init silently misses errors that fire
// before the call.
//
// Gated on SENTRY_DSN so local dev and tests don't ship telemetry. When
// the env var is unset the init is a no-op and Sentry.captureException
// becomes a cheap noop call — safe to leave in error paths unconditionally.

import * as Sentry from '@sentry/node'

const dsn = process.env['SENTRY_DSN']
if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env['NODE_ENV'] ?? 'development',
    // Trace 10% of requests by default. Crank up for low-traffic stages,
    // dial down once volume climbs — Sentry pricing is per span.
    tracesSampleRate: Number(process.env['SENTRY_TRACES_SAMPLE_RATE'] ?? '0.1'),
    // Don't send PII by default. We tag manually in the error handler with
    // request_id / route / agent_id; nothing else from the request belongs
    // in error reports.
    sendDefaultPii: false,
  })
}

export { Sentry }
