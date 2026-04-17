import './instrument.js' // MUST be first — Sentry hooks node internals at init
import './env.js' // Validate env vars immediately — crash on missing credentials
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { startWebhookWorker, stopWebhookWorker } from './services/webhook-worker.js'
import {
  startGroupDeletionFanoutWorker,
  stopGroupDeletionFanoutWorker,
} from './services/group-deletion-fanout-worker.js'
import { startDlqProbe, stopDlqProbe } from './services/dlq-probe.js'
import { initPubSub, shutdownPubSub, getPubSubHealth } from './ws/pubsub.js'
import { logger } from './lib/logger.js'
import { serialize } from './lib/metrics.js'
import { Sentry } from './instrument.js'

// Background worker process. Owns:
//   * webhook delivery polling (claim_webhook_deliveries → fetch → mark)
//   * group-deletion fan-out queue draining (mig 030 — publishes WS pushes
//     across pub/sub so the api-server processes deliver to local sockets)
//   * DLQ-health probe (DB count + drift + circuit-open gauges, alerting)
//
// Split from the api-server process so an HTTP request burst (e.g. 1M agents
// reconnecting at once) can't starve webhook fan-out, and so a slow/blocked
// webhook receiver can't tie up the request loop. Both processes ship the
// same Docker image; fly.toml [processes] points each Machine at the right
// entrypoint (api = node dist/index.js, worker = node dist/worker.js).
//
// Pub/sub init: the worker holds zero WebSocket connections itself, but
// the group-deletion fan-out worker publishes WS events through Redis so
// api-server processes deliver them to live sockets. Calling initPubSub
// here brings up the publisher (and a subscriber that effectively no-ops
// against the empty local registry — single-digit-bytes/sec overhead).
// When REDIS_URL is unset, publishToAgent falls back to local delivery,
// which in the worker means "no live push" — but the system message is
// already durable via /sync, so the recipient still gets the deletion
// event on next reconnect.
//
// Exposes /internal/metrics on WORKER_PORT (default 9091) for Prometheus
// scrape over Fly's 6PN. The api process's /internal/metrics covers
// api-side counters; scraping both endpoints gives the full picture, since
// our metrics registry is per-process.
//
// Health probe lives at /health for Fly's checks block. Cheap — just 200.

const PORT = Number(process.env['WORKER_PORT'] ?? 9091)

const app = new Hono()

// Health check — drives Fly's [[services.tcp_checks]] block (fly.toml line 58).
// Same pub/sub-aware logic as the api process: when REDIS_URL is set, we
// need at least one of publisher/subscriber ready for this worker to do
// useful cross-machine work. Group-deletion fan-out specifically PUBLISHES
// from the worker to api-server processes — a publisher-down worker can
// still drain its DB queue but recipients on other machines stop getting
// the live push (they'll catch up on /sync, but the real-time guarantee
// is broken). Treating it the same as the api process keeps the
// quarantine semantics consistent across the whole pool.
app.get('/health', (c) => {
  const ps = getPubSubHealth()
  if (ps.expected && !ps.publisherReady && !ps.subscriberReady) {
    return c.json(
      {
        status: 'degraded',
        pubsub: { publisher: false, subscriber: false },
      },
      503,
    )
  }
  return c.json({
    status: 'ok',
    ...(ps.expected && {
      pubsub: { publisher: ps.publisherReady, subscriber: ps.subscriberReady },
    }),
  })
})

app.get('/internal/metrics', (c) => {
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

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  logger.info({ port: info.port }, 'worker_http_listening')
})

initPubSub(process.env['REDIS_URL'])
startWebhookWorker()
startGroupDeletionFanoutWorker()
startDlqProbe()
logger.info({ pid: process.pid }, 'worker_started')

// Graceful shutdown. Fly sends SIGINT, then SIGTERM after the grace period;
// we treat both the same — drain in-flight HTTP, stop polling, flush
// Sentry, then exit.
let shuttingDown = false
async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  logger.info({ signal }, 'worker_shutdown_initiated')

  // Await both workers — each tick can be mid-flight (claim → publish/fetch
  // → mark); we want the in-flight batch to settle before the HTTP server
  // closes and the process exits, otherwise rows sit in 'delivering' for
  // the 60s stale-row reclaim window and re-fire on a different worker.
  // Awaited in parallel because they're independent queues.
  await Promise.all([stopWebhookWorker(), stopGroupDeletionFanoutWorker()])
  stopDlqProbe()

  await new Promise<void>((resolve) => server.close(() => resolve()))

  // Drop pub/sub last so any tail-end publishes from the workers above
  // (e.g. a final WS push during their drain) actually reach Redis.
  shutdownPubSub()

  // Sentry has an internal queue that batches events; flush before exit so
  // last-second errors aren't dropped. 2s budget is plenty for the volume
  // a single worker generates.
  try {
    await Sentry.close(2000)
  } catch {
    // best-effort
  }

  logger.info('worker_shutdown_complete')
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

// Crashes that escape the event loop should still notify Sentry before we die.
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'worker_uncaught_exception')
  Sentry.captureException(err)
  void Sentry.close(2000).finally(() => process.exit(1))
})
process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'worker_unhandled_rejection')
  Sentry.captureException(err)
})
