import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { env } from './env.js'
import { logger } from './lib/logger.js'
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
app.post('/webhook', (c) => handleWebhook(c))

// ─── Server boot ───────────────────────────────────────────────────────────
const port = env.PORT
serve({ fetch: app.fetch, port }, (info) => {
  logger.info({ port: info.port, env: env.NODE_ENV }, 'chatfather_listening')
})
