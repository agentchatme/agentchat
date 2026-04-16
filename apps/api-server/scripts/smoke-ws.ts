import { randomBytes, createHash } from 'node:crypto'
import WebSocket from 'ws'
import { insertAgent } from '@agentchat/db'
import { generateId } from '../src/lib/id.js'

// End-to-end smoke test that exercises every layer of the runtime stack
// against the deployed production stack on Fly:
//
//   client → HTTPS → Hono /v1/messages → Postgres send_message_atomic
//            → Redis pub/sub broadcast → recipient WebSocket envelope
//
// If this passes against agentchat-api.fly.dev, the api process, the
// worker's effect on shared infra, and the cross-Machine pub/sub bus are
// all functional after the latest deploy. Single command, no test agents
// required to pre-exist — we seed two fresh ones and tear nothing down
// (the rows are harmless, ~200 bytes each).
//
// Run from the api-server package:
//   pnpm exec tsx --env-file=../../.env scripts/smoke-ws.ts

const API_BASE = process.env.API_BASE ?? 'https://agentchat-api.fly.dev'
const WS_BASE = API_BASE.replace(/^http/, 'ws')

// How long we wait between connecting Bob's socket and posting Alice's
// message. Gives Redis pub/sub + presence write time to propagate so the
// post lands while Bob is registered as online. 1s is generous on Fly.
const REGISTRATION_GRACE_MS = 1_000

// Outer timeout — if the envelope doesn't arrive within this window,
// something is broken (slow pub/sub, dropped sub, dead worker). 15s
// covers cold-start + cross-region propagation worst case on shared-cpu.
const ENVELOPE_TIMEOUT_MS = 15_000

function randSuffix() {
  return randomBytes(3).toString('hex')
}

function makeApiKey() {
  return `ac_${randomBytes(32).toString('base64url')}`
}

async function createAgent(label: string) {
  const suffix = randSuffix()
  const handle = `${label}-smoke-${suffix}`
  const email = `${label}-smoke-${suffix}@agentchat.local`
  const apiKey = makeApiKey()
  const apiKeyHash = createHash('sha256').update(apiKey).digest('hex')
  const id = generateId('agt')
  const agent = await insertAgent({
    id,
    handle,
    email,
    api_key_hash: apiKeyHash,
    display_name: `${label[0]!.toUpperCase()}${label.slice(1)} (smoke)`,
    description: 'Smoke-test agent — safe to delete',
  })
  return { id: agent.id as string, handle: agent.handle as string, apiKey }
}

interface Envelope {
  type: string
  payload?: { content?: { text?: string }; sender?: string }
}

function connectAndAwait(
  apiKey: string,
  matcher: (env: Envelope) => boolean,
): Promise<{ ws: WebSocket; envelope: Envelope }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/v1/ws`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error(`No matching envelope within ${ENVELOPE_TIMEOUT_MS}ms`))
    }, ENVELOPE_TIMEOUT_MS)

    ws.on('open', () => {
      console.log('[ws] open')
    })
    ws.on('message', (raw) => {
      let env: Envelope
      try {
        env = JSON.parse(String(raw)) as Envelope
      } catch {
        return
      }
      console.log(`[ws] frame type=${env.type}`)
      if (matcher(env)) {
        clearTimeout(timer)
        resolve({ ws, envelope: env })
      } else if (env.type === 'message.new') {
        // Surface unmatched message.new frames so a schema drift doesn't
        // look like a delivery failure.
        console.log('[ws] unmatched message.new payload:', JSON.stringify(env.payload, null, 2))
      }
    })
    ws.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    ws.on('close', (code, reason) => {
      console.log(`[ws] close code=${code} reason=${reason.toString()}`)
    })
  })
}

async function postMessage(apiKey: string, toHandle: string, text: string) {
  const clientMsgId = `smoke_${randomBytes(6).toString('hex')}`
  const res = await fetch(`${API_BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      to: `@${toHandle}`,
      client_msg_id: clientMsgId,
      type: 'text',
      content: { text },
    }),
  })
  const body = await res.text()
  if (!res.ok) {
    throw new Error(`POST /v1/messages failed: ${res.status} ${body}`)
  }
  return { status: res.status, body, clientMsgId }
}

async function main() {
  console.log(`─── smoke-ws against ${API_BASE} ───`)

  console.log('Seeding two agents...')
  const alice = await createAgent('alice')
  const bob = await createAgent('bob')
  console.log(`  alice → @${alice.handle}`)
  console.log(`  bob   → @${bob.handle}`)

  const PROBE_TEXT = `smoke-${randomBytes(4).toString('hex')}`
  console.log(`Probe text: "${PROBE_TEXT}"`)

  console.log('Opening WS as Bob...')
  const waitForEnvelope = connectAndAwait(bob.apiKey, (env) => {
    return (
      env.type === 'message.new' &&
      env.payload?.content?.text === PROBE_TEXT &&
      env.payload?.sender === alice.handle
    )
  })

  await new Promise((r) => setTimeout(r, REGISTRATION_GRACE_MS))

  console.log('Posting message from Alice → Bob...')
  const post = await postMessage(alice.apiKey, bob.handle, PROBE_TEXT)
  console.log(`  POST returned ${post.status}`)

  const { ws, envelope } = await waitForEnvelope
  console.log('')
  console.log('✅ Envelope received on Bob\'s socket:')
  console.log(JSON.stringify(envelope, null, 2))
  ws.close()

  // Brief pause so the close frame actually flushes before the process
  // exits — otherwise the server logs a 1006 abnormal close.
  await new Promise((r) => setTimeout(r, 250))
  console.log('')
  console.log('─── PASS — full stack is live ───')
}

main().catch((err) => {
  console.error('')
  console.error('─── FAIL ───')
  console.error(err)
  process.exit(1)
})
