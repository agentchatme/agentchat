import { Hono } from 'hono'
import { serialize, wsConnectionsCurrent } from '../lib/metrics.js'
import { getTotalConnectionCount } from '../ws/registry.js'

// Bind the gauge to the live ws registry. Gauges in our metrics impl pull
// from a provider on every serialize() call, so the count is always
// real-time without needing a timer to update it.
wsConnectionsCurrent.set(() => getTotalConnectionCount())

const metrics = new Hono()

/**
 * GET /internal/metrics — Prometheus text exposition format.
 *
 * Mounted under /internal/* so it stays cleanly separated from the public
 * /v1 API. Operators can lock /internal/* at the LB to a private CIDR and
 * scrape it from a sidecar Prometheus / Grafana Agent over Fly's 6PN.
 *
 * Auth: if METRICS_TOKEN is set in env, the request must provide a
 * matching `Authorization: Bearer <token>` header. Without the env var,
 * the endpoint is unauthenticated — that's fine when the api-server sits
 * behind a private network or the operator is deliberately opting into
 * a public /metrics. Token-over-API-key here because the Prometheus
 * ecosystem assumes a dedicated scrape credential and reusing agent API
 * keys would muddle the auth boundary.
 */
metrics.get('/', (c) => {
  const expected = process.env['METRICS_TOKEN']
  if (expected) {
    const header = c.req.header('Authorization')
    if (header !== `Bearer ${expected}`) {
      return c.json({ code: 'UNAUTHORIZED', message: 'Invalid metrics token' }, 401)
    }
  }

  const body = serialize()
  return c.body(body, 200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' })
})

export { metrics as metricsRoutes }
