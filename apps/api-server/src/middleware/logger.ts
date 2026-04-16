import { randomUUID } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import { logger } from '../lib/logger.js'

// Structured request logger. Every request gets:
//   * a request_id (honored from X-Request-Id if the caller sent one — useful
//     for stitching client-side tracing through the API), echoed back via
//     the response header so the client can correlate;
//   * stashed on c.set so handlers can include it in their own log lines /
//     pass to Sentry on error;
//   * a single completion log line with method, path, status, duration_ms.
//
// 4xx logs at warn, 5xx at error, everything else at info. Health probes
// and the metrics endpoint are demoted to debug to keep info-level signal
// clean — they fire every few seconds and would otherwise dominate output.

const QUIET_PATHS = new Set(['/', '/v1/health', '/internal/metrics'])

export const requestLogger: MiddlewareHandler = async (c, next) => {
  const incoming = c.req.header('x-request-id')
  const requestId = incoming && incoming.length <= 128 ? incoming : randomUUID()
  c.set('request_id', requestId)
  c.header('X-Request-Id', requestId)

  const start = Date.now()
  await next()
  const durationMs = Date.now() - start

  const status = c.res.status
  const method = c.req.method
  const path = c.req.path

  const fields = {
    request_id: requestId,
    method,
    path,
    status,
    duration_ms: durationMs,
  }

  if (status >= 500) {
    logger.error(fields, 'request')
  } else if (status >= 400) {
    logger.warn(fields, 'request')
  } else if (QUIET_PATHS.has(path)) {
    logger.debug(fields, 'request')
  } else {
    logger.info(fields, 'request')
  }
}
