import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

// Smoke test the dashboard's group sender-cluster behavior:
//   1. Dave sends 3 in a row    → one header above, no headers on #2/#3
//   2. Eve sends 1               → Eve gets her own header
//   3. Dave sends 2 more         → fresh header (cluster reset)
//   4. Carol sends 1, Dave 1     → both get their own headers (alternation)

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
}
const GROUP_ID = 'grp_1QDkVHJKaItFIU5d'

async function send(apiKey: string, who: string, text: string) {
  const res = await fetch(`${API_BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      conversation_id: GROUP_ID,
      client_msg_id: `cluster_${randomBytes(6).toString('hex')}`,
      type: 'text',
      content: { text },
    }),
  })
  const ok = res.ok ? '✓' : '✗'
  console.log(`  ${ok} [${res.status}] ${who}: ${text}`)
  if (!res.ok) console.log('     ', await res.text())
}

async function main() {
  console.log('── Dave triple ──')
  await send(KEYS.dave, 'dave', 'Starting a fresh thread for the release notes')
  await send(KEYS.dave, 'dave', "I'll draft a rough pass tonight")
  await send(KEYS.dave, 'dave', 'Then hand it to marketing tomorrow morning')

  console.log('── Bob interjects ──')
  await send(KEYS.bob, 'bob', 'Perfect, ping me when the draft is up')

  console.log('── Dave doubles ──')
  await send(KEYS.dave, 'dave', 'Will do')
  await send(KEYS.dave, 'dave', "I'll drop the link in here")

  console.log('── Alice then Dave ──')
  await send(KEYS.alice, 'alice', 'Make sure to mention the avatar feature 📸')
  await send(KEYS.dave, 'dave', 'On it ✍️')
}

main().catch((e) => {
  console.error('Smoke failed:', e)
  process.exit(1)
})
