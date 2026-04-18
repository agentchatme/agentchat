import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

// One-off smoke test: push emoji-rich messages across all seeded
// conversations to visually verify rendering in the dashboard.
// Reads API keys from .env.test-agents at the repo root (written by
// scripts/seed-test-agents.ts).

const FIXTURE = resolve(process.cwd(), '../..', '.env.test-agents')
const API_BASE = 'https://api.agentchat.me'

function parseEnvFile(path: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m) env[m[1]!] = m[2]!
  }
  return env
}

const env = parseEnvFile(FIXTURE)

const KEYS = {
  alice: env['TEST_ALICE_API_KEY']!,
  bob: env['TEST_BOB_API_KEY']!,
  carol: env['TEST_CAROL_API_KEY']!,
  dave: env['TEST_DAVE_API_KEY']!,
  eve: env['TEST_EVE_API_KEY']!,
}

// Conversation ids from the last seed run; hard-coded because we just
// created them. If they rotate, pull from /dashboard/... or re-seed.
const CONV = {
  ab: 'conv_d6YAy98A4PTqSZZP',
  ac: 'conv_wDyok_Dn-0_X6Ce0',
  be: 'conv_Lu4YOtx8Q-8G-rZx',
  grp: 'grp_1QDkVHJKaItFIU5d',
}

async function send(
  apiKey: string,
  target: { to?: string; conversation_id?: string },
  text: string,
) {
  const clientMsgId = `smoke_${randomBytes(6).toString('hex')}`
  const res = await fetch(`${API_BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...target,
      client_msg_id: clientMsgId,
      type: 'text',
      content: { text },
    }),
  })
  const ok = res.ok ? '✓' : '✗'
  console.log(`  ${ok} [${res.status}] ${text}`)
  if (!res.ok) console.log('     ', await res.text())
}

const H = {
  alice: env['TEST_ALICE_HANDLE']!,
  bob: env['TEST_BOB_HANDLE']!,
  carol: env['TEST_CAROL_HANDLE']!,
  dave: env['TEST_DAVE_HANDLE']!,
  eve: env['TEST_EVE_HANDLE']!,
}

async function main() {
  console.log('── alice ↔ bob ──')
  await send(KEYS.alice, { to: H.bob }, 'Smoke-testing emoji now 🧪')
  await send(KEYS.bob, { to: H.alice }, 'Looks good on my side 👍🏽✨')
  await send(KEYS.alice, { to: H.bob }, "🎉🎊 let's try a family: 👨‍👩‍👧‍👦")
  await send(KEYS.bob, { to: H.alice }, 'Flags render? 🇺🇸🇯🇵🇮🇳🇩🇪🇧🇷')

  console.log('── alice ↔ carol ──')
  await send(KEYS.alice, { to: H.carol }, 'Heart variants ❤️💛💚💙💜🖤🤍🤎')
  await send(KEYS.carol, { to: H.alice }, 'Skin tones 👋🏻👋🏼👋🏽👋🏾👋🏿')
  await send(KEYS.alice, { to: H.carol }, 'Mixed text + emoji: shipping 🚢 at 5pm ⏰')

  console.log('── bob ↔ eve ──')
  await send(KEYS.bob, { to: H.eve }, 'Late reply incoming 🦥')
  await send(KEYS.eve, { to: H.bob }, 'Got it. Fire 🔥 and sparkles ✨ both present.')

  // Group sends also went out in the prior run; skipping to avoid
  // double-posting. Re-enable if the script is ever used in isolation.
  // console.log('── group Team AgentChat ──')
  // await send(KEYS.alice, { conversation_id: CONV.grp }, '...')
}

main().catch((e) => {
  console.error('Smoke failed:', e)
  process.exit(1)
})
