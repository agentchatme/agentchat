import { AgentChatClient } from 'agentchat'

// ─── Chatfather end-to-end smoke test ──────────────────────────────────────
//
// Uses a pre-seeded test agent (TEST_ALICE_* from .env.test-agents) to
// send a DM to @chatfather against the deployed api-server, then polls
// the conversation for chatfather's reply. A pass proves the full loop:
//
//   alice  → POST /v1/messages      → api-server
//          ← stored message
//          → webhook_deliveries row → api-server worker
//          → HTTPS POST /webhook    → chatfather (Fly)
//          → HMAC verify + SETNX    → fast-path or LLM
//          → sendReply() via SDK    → api-server
//          → POST /v1/messages      → stored message
//          ← alice polls GET /v1/messages/:convId?after_seq=N → sees reply
//
// Invocation (from repo root):
//
//   # fast-path smoke (sends "/help", costs no LLM budget):
//   pnpm exec tsx --env-file=.env.test-agents apps/chatfather/scripts/smoke.ts
//
//   # LLM path smoke (forces a fall-through to OpenRouter):
//   pnpm exec tsx --env-file=.env.test-agents apps/chatfather/scripts/smoke.ts --llm
//
// Exit code 0 = reply received, 1 = timed out, 2 = setup error. Designed
// for CI and for running manually after a deploy — no agent teardown,
// no DB writes outside the usual conversation rows.

const API_BASE = process.env['API_BASE'] ?? 'https://api.agentchat.me'
const API_KEY = process.env['TEST_ALICE_API_KEY']
const HANDLE = process.env['TEST_ALICE_HANDLE']

if (!API_KEY || !HANDLE) {
  console.error('Missing TEST_ALICE_API_KEY / TEST_ALICE_HANDLE — run with --env-file=.env.test-agents')
  process.exit(2)
}

const FORCE_LLM = process.argv.includes('--llm')

// For the LLM path we want something that will NOT match the fast-path
// FAQ keyword list. Adding a random token ensures the exact string has
// never been cached by the 10-minute content-hash cache. The question
// is phrased as novel chatfather meta-commentary so the LLM has something
// coherent to reply with (rather than "I don't know").
const rand = Math.random().toString(36).slice(2, 8)
const question = FORCE_LLM
  ? `Describe in one sentence why AgentChat agent ${rand} might hypothetically choose structured messages over plain text.`
  : '/help'

// Reply timeout. Fast-path is ~1s; LLM path includes the webhook delivery
// worker cadence (~2s polling) + OpenRouter latency (up to 10s TIMEOUT_MS).
// 45s covers p99 of the LLM path with headroom for Fly cold-start.
const REPLY_TIMEOUT_MS = 45_000
const POLL_INTERVAL_MS = 1_500

async function main(): Promise<void> {
  const client = new AgentChatClient({ apiKey: API_KEY!, baseUrl: API_BASE })

  console.log(`[smoke] mode=${FORCE_LLM ? 'llm' : 'fast-path'}`)
  console.log(`[smoke] base=${API_BASE}`)
  console.log(`[smoke] from=@${HANDLE}`)
  console.log(`[smoke] question: ${question}`)

  const t0 = Date.now()
  const sent = await client.sendMessage({
    to: '@chatfather',
    content: { text: question },
  })

  const conversationId = sent.message.conversation_id
  const sentSeq = sent.message.seq
  console.log(
    `[smoke] sent msg=${sent.message.id} convo=${conversationId} seq=${sentSeq} after=${Date.now() - t0}ms`,
  )

  const deadline = Date.now() + REPLY_TIMEOUT_MS
  let polls = 0
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    polls++
    const msgs = await client.getMessages(conversationId, {
      afterSeq: sentSeq,
      limit: 10,
    })
    // Any message authored by the other side of the convo is chatfather's
    // reply. We compare by handle; api-server normalizes sender to handle
    // on the envelope.
    const reply = msgs.find((m) => m.sender !== HANDLE && m.content.text)
    if (reply) {
      const latency = Date.now() - t0
      console.log(`[smoke] reply received after ${latency}ms (${polls} polls)`)
      console.log(`[smoke] reply.sender=${reply.sender} seq=${reply.seq}`)
      console.log('---')
      console.log(reply.content.text)
      console.log('---')
      process.exit(0)
    }
  }

  console.error(`[smoke] no reply within ${REPLY_TIMEOUT_MS}ms — check chatfather logs:`)
  console.error(`  flyctl logs -a agentchat-chatfather`)
  process.exit(1)
}

main().catch((err) => {
  console.error('[smoke] setup error:', err)
  process.exit(2)
})
