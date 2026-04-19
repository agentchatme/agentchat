import './instrument.js' // MUST be first — Sentry hooks node internals at init
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { env } from './env.js'
import { Sentry } from './instrument.js'
import { logger } from './lib/logger.js'
import { track, waitForDrain, getInFlight } from './lib/inflight.js'
import { handleWebhook } from './webhook.js'

// ─── Chatfather — the AgentChat support agent ──────────────────────────────
//
// Architecture (Telegram-bot + autonomous-agent hybrid):
//
//   api-server                          chatfather (this process)
//   ──────────                          ──────────
//   agent.created  ──(webhook)──▶     POST /webhook
//   message.new    ──(webhook)──▶     POST /webhook
//                                      │
//                                      ├─ HMAC verify (task #14)
//                                      ├─ Redis SETNX 24h idempotency (task #14)
//                                      ├─ Fast-path router (task #15)
//                                      │    /help, /report, greetings, FAQ keywords
//                                      ├─ LLM fallback via OpenRouter (task #16)
//                                      │    grounded on bundled FAQ .md + known-issues
//                                      ├─ Safety layer (task #17)
//                                      │    per-sender rate, daily cap, content-hash collapse
//                                      ├─ Escalation queue (task #18)
//                                      │    write support_escalations row + ack
//                                      └─ Outbound via SDK (task #19)
//                                           Idempotency-Key = hash(source msg + reply)
//
// Why a separate Fly app rather than an api-server process group:
//   - Different failure domain — an OOM in chatfather's LLM path cannot
//     page out WebSocket connections on the api process.
//   - Different secrets surface — OPENROUTER_API_KEY and OPS_WEBHOOK_SECRET
//     never land in the env of the main api process.
//   - Different scaling profile — webhook bursts (new agent registration
//     wave) need different headroom than steady-state WS fan-out.

const app = new Hono()

// ─── Health check ──────────────────────────────────────────────────────────
// Fly's [checks.health] polls this every 15s. Kept deliberately minimal —
// a 200 with a small JSON body is enough. Don't add a Redis/Supabase ping
// here; a flaky dependency would flap machines in and out of the load
// balancer even though the ingest path itself is fine (fast-path doesn't
// need Redis for every request).
app.get('/healthz', (c) => c.json({ ok: true, service: 'chatfather' }))

// ─── Webhook ingest ────────────────────────────────────────────────────────
// HMAC verification → Redis SETNX idempotency → parse+dispatch. See
// src/webhook.ts for the processing-order rationale.
//
// Wrapped in `track()` so the SIGTERM handler can drain in-flight
// deliveries before the process exits — otherwise Fly kills chatfather
// mid-dispatch and api-server's outbox has to retry, adding user-visible
// latency during rolling deploys.
app.post('/webhook', (c) => track(() => handleWebhook(c)))

// ─── Server boot ───────────────────────────────────────────────────────────
const port = env.PORT
const server = serve({ fetch: app.fetch, port }, (info) => {
  logger.info({ port: info.port, env: env.NODE_ENV }, 'chatfather_listening')
})

// ─── Graceful shutdown ─────────────────────────────────────────────────────
// Fly sends SIGINT when it wants a machine to stop (deploy replacement,
// scale-down, host migration). After a grace period — typically 5s,
// overridable via `kill_timeout` in fly.toml — it escalates to SIGKILL.
// We treat SIGINT and SIGTERM the same: stop accepting new requests,
// drain in-flight webhook processing, flush Sentry, exit.
//
// The 8s drain budget is inside Fly's default 5s kill_timeout window
// only IF kill_timeout is bumped — without that, Fly SIGKILLs at 5s
// and the last 3s of our budget is moot. fly.chatfather.toml doesn't
// set kill_timeout explicitly; the ingest path is fast enough (burst
// rate → Supabase age check → Redis → Supabase insert is typically
// <500ms) that 5s is enough for the common case.
const DRAIN_TIMEOUT_MS = 8_000

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  logger.info({ signal, in_flight: getInFlight() }, 'chatfather_shutdown_initiated')

  // 1. Stop accepting new requests. server.close() keeps existing
  //    connections open so in-flight processing isn't aborted — it just
  //    stops handing out new ones. Fly's load balancer sees the machine
  //    as unhealthy on the next /healthz poll and routes away.
  await new Promise<void>((resolve) => {
    server.close((err) => {
      if (err) logger.warn({ err }, 'chatfather_server_close_warn')
      resolve()
    })
  })

  // 2. Wait for in-flight dispatch to complete. Anything past HMAC +
  //    idempotency is already past the point where api-server can safely
  //    retry (the SETNX slot is claimed), so we'd rather finish than
  //    abandon. On timeout the survivors get retried via api-server's
  //    outbox — not ideal but not data-loss.
  const drainResult = await waitForDrain(DRAIN_TIMEOUT_MS)
  logger.info(
    { drain_result: drainResult, remaining: getInFlight() },
    'chatfather_drain_complete',
  )

  // 3. Flush Sentry's batched queue before exit. 2s budget is plenty for
  //    the volume chatfather generates. close() also disables further
  //    capture, which is what we want post-shutdown.
  try {
    await Sentry.close(2000)
  } catch {
    // best-effort — if Sentry hung, we still need to exit
  }

  logger.info('chatfather_shutdown_complete')
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

// ─── Last-resort crash hooks ───────────────────────────────────────────────
// Anything that escapes the event loop (sync throw in a callback, promise
// rejected without a .catch, native module fault) still gets into Sentry
// before we die. Without these, a crash is invisible outside of Fly logs —
// and Fly logs rotate fast.
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'chatfather_uncaught_exception')
  Sentry.captureException(err)
  void Sentry.close(2000).finally(() => process.exit(1))
})
process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'chatfather_unhandled_rejection')
  Sentry.captureException(err)
})
