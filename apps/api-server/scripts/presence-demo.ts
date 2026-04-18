import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import WebSocket from 'ws'

// Demo script for the dashboard's presence drawer. Opens a WebSocket
// for each of the four seeded test agents (Alice/Bob/Carol/Dave)
// against production — which triggers setPresence(online) on the
// server via ws/handler.ts and keeps the Redis TTL fresh via the
// built-in 30s ping/pong heartbeat. Click any of their avatars in
// the dashboard → "Active now". Ctrl+C cleanly disconnects, which
// calls clearPresence → status offline + last_seen stamp → the
// drawer then shows "Last seen X ago" on refresh.
//
// Run from apps/api-server:
//   pnpm exec tsx --env-file=../../.env scripts/presence-demo.ts

const FIXTURE = resolve(process.cwd(), '../..', '.env.test-agents')
const API_BASE = process.env.API_BASE ?? 'https://api.agentchat.me'
const WS_BASE = API_BASE.replace(/^http/, 'ws')

function parseEnvFile(path: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m) env[m[1]!] = m[2]!
  }
  return env
}

const env = parseEnvFile(FIXTURE)
const AGENTS = [
  { label: 'alice', handle: env['TEST_ALICE_HANDLE']!, apiKey: env['TEST_ALICE_API_KEY']! },
  { label: 'bob', handle: env['TEST_BOB_HANDLE']!, apiKey: env['TEST_BOB_API_KEY']! },
  { label: 'carol', handle: env['TEST_CAROL_HANDLE']!, apiKey: env['TEST_CAROL_API_KEY']! },
  { label: 'dave', handle: env['TEST_DAVE_HANDLE']!, apiKey: env['TEST_DAVE_API_KEY']! },
]

function connect(label: string, handle: string, apiKey: string): WebSocket {
  const ws = new WebSocket(`${WS_BASE}/v1/ws`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  ws.on('open', () => {
    console.log(`  ✓ ${label} (@${handle}) online`)
  })
  ws.on('close', (code) => {
    console.log(`  × ${label} (@${handle}) closed [${code}]`)
  })
  ws.on('error', (err) => {
    console.error(`  ! ${label} error:`, err.message)
  })
  return ws
}

async function main() {
  console.log(`─── presence-demo against ${API_BASE} ───`)
  console.log('Opening WebSocket for each test agent...')
  const sockets = AGENTS.map((a) => connect(a.label, a.handle, a.apiKey))

  console.log('')
  console.log('All sockets open. Click any of these avatars in the dashboard:')
  for (const a of AGENTS) console.log(`  • @${a.handle}`)
  console.log('')
  console.log('You should see "Active now" on every profile.')
  console.log('Press Ctrl+C to gracefully disconnect → "Last seen X ago".')
  console.log('')

  // Hold open until SIGINT. The ws library handles ping/pong
  // automatically, so the server-side 30s heartbeat keeps the
  // presence TTL fresh on its own.
  await new Promise<void>((resolvePromise) => {
    process.on('SIGINT', () => {
      console.log('')
      console.log('Disconnecting...')
      for (const s of sockets) {
        try { s.close(1000, 'demo done') } catch {}
      }
      // Give close frames a moment to flush before the process exits.
      setTimeout(() => {
        console.log('Done. Refresh the dashboard to see "Last seen X ago".')
        resolvePromise()
      }, 500)
    })
  })
}

main().catch((e) => {
  console.error('presence-demo failed:', e)
  process.exit(1)
})
