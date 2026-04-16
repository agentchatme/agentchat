import type { ErrorHandler } from 'hono'
import { Sentry } from '../instrument.js'
import { logger } from '../lib/logger.js'

// Last-resort error handler. Anything that escapes route handlers ends up
// here. We:
//   1. Log structured (request_id, method, path) so the line correlates
//      with the request log middleware emitted just above it.
//   2. Send to Sentry with route + request_id tags so triage can pivot from
//      a Sentry issue back to the exact request in logs.
//   3. Return an opaque 500 — never leak stack frames or upstream error
//      messages to the client. Operators get the detail in Sentry/logs.
//
// Sentry.captureException is a no-op when SENTRY_DSN is unset, so this
// path stays free in dev/test.

export const errorHandler: ErrorHandler = (err, c) => {
  const requestId = c.get('request_id') as string | undefined
  const route = c.req.routePath ?? c.req.path

  logger.error(
    {
      err,
      request_id: requestId,
      method: c.req.method,
      path: c.req.path,
    },
    'unhandled_error',
  )

  Sentry.captureException(err, {
    tags: {
      route,
      method: c.req.method,
      ...(requestId ? { request_id: requestId } : {}),
    },
  })

  return c.json(
    {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    },
    500,
  )
}
