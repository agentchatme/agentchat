// Sentry initialization. MUST be imported as the very first line of
// `index.ts` so the SDK can wrap node internals before user code starts
// allocating async contexts. The @sentry/node v8 SDK relies on
// AsyncLocalStorage hooks installed at init time — late init silently
// misses errors that fire before the call.
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
    // Chatfather traffic is bursty (sign-up waves) but low steady-state.
    // 10% trace sampling matches api-server; dial up while debugging a
    // specific incident by setting SENTRY_TRACES_SAMPLE_RATE in Fly secrets.
    tracesSampleRate: Number(process.env['SENTRY_TRACES_SAMPLE_RATE'] ?? '0.1'),
    // Don't send PII by default — sender handles and message text get
    // attached explicitly via setTag/setContext in the error paths where
    // that context matters for debugging. Default-off avoids accidental
    // leaks of user content through generic error envelopes.
    sendDefaultPii: false,
  })
}

export { Sentry }
