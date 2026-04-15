import { randomBytes } from 'node:crypto'

// End-to-end variant of live-chat.ts. Instead of writing directly to
// the database via @agentchat/db, this posts to the real public API
// the way any SDK client would — Bearer API key, JSON body, rate
// limits, idempotency middleware, the whole transport path. Use this
// to verify that the send route actually works, not just that the
// database schema accepts the rows.
//
// The DB-level sibling (scripts/live-chat.ts) stays around for fast
// seeding when you don't care about the HTTP surface.

const API_BASE = process.env.API_BASE ?? 'https://agentchat-api.fly.dev'

const ALICE_KEY = 'ac_VdtcH8QP2vYqlLdflSr8V-kqdSgTIJLzvQh3o-a4x60'
const ALICE_HANDLE = 'alice-test-2b3fe1'
const BOB_KEY = 'ac_pEHORPv3Hm9lV6wOO16pwQhIg8O6ot7DY8d9HUlS5qQ'
const BOB_HANDLE = 'bob-test-86cd35'

const script: Array<['alice' | 'bob', string]> = [
  ['alice', 'HTTP round now — every line is a real POST /v1/messages.'],
  ['bob', 'Confirmed. Bearer auth, rate limit, idempotency — full route.'],
  ['alice', 'If this works it means the send path is healthy end to end.'],
  ['bob', 'And not just that the DB schema is happy. Good test.'],
  ['alice', 'Idempotency note: each client_msg_id is unique per send.'],
  ['bob', 'So replays would return the same row instead of duplicating.'],
  ['alice', 'Last one — scrolling should still anchor to the bottom.'],
  ['bob', 'Received. We are good.'],
]

async function send(apiKey: string, to: string, text: string) {
  const clientMsgId = `httplive_${randomBytes(6).toString('hex')}`
  const res = await fetch(`${API_BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      to,
      client_msg_id: clientMsgId,
      type: 'text',
      content: { text },
    }),
  })
  const bodyText = await res.text()
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${bodyText}`)
  }
  return { status: res.status, body: bodyText }
}

async function main() {
  for (const [who, text] of script) {
    const key = who === 'alice' ? ALICE_KEY : BOB_KEY
    const to = who === 'alice' ? BOB_HANDLE : ALICE_HANDLE
    const { status } = await send(key, to, text)
    console.log(`[${new Date().toISOString()}] ${status} ${who} -> @${to}: ${text}`)
    await new Promise((r) => setTimeout(r, 3000))
  }
  console.log('done')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
