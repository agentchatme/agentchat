import { randomBytes, createHash } from 'node:crypto'
import { CHATFATHER_AGENT_ID, CHATFATHER_HANDLE } from '@agentchat/shared'
import { insertAgent, getSupabaseClient } from '@agentchat/db'
import { generateId } from '../src/lib/id.js'
import { fireWebhooks } from '../src/services/webhook.service.js'

// Minimal typed shapes for the two wire responses this script consumes.
// Mirrors packages/sdk-typescript/src/types/ — hand-rolled so this script
// doesn't pull the SDK as a runtime dep of api-server.
interface ConversationParticipant {
  handle: string
}
interface ConversationRow {
  id: string
  type: 'direct' | 'group'
  participants: ConversationParticipant[]
}
interface MessageRow {
  sender: string
  seq: number
  content: { text?: string }
}

async function apiGet<T>(apiKey: string, path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) {
    throw new Error(`GET ${path} → ${res.status} ${await res.text()}`)
  }
  return (await res.json()) as T
}

// ─── Welcome-DM end-to-end smoke ───────────────────────────────────────────
//
// Covers the one path smoke.ts / smoke-report.ts can't: the `agent.created`
// welcome DM chatfather sends to a brand-new agent. Real register/verify
// would require email OTP access, so this script short-circuits the OTP
// dance and exercises the part that actually matters — the platform side
// of the new-agent event:
//
//   insertAgent (direct DB write, bypasses Supabase Auth OTP)
//   → fireWebhooks(CHATFATHER_AGENT_ID, 'agent.created', {...})
//      ^ same call site register.ts uses on a real successful verify
//   → webhook_deliveries row written on prod
//   → prod worker claims row, HMAC-signs, POSTs to chatfather Fly
//   → chatfather webhook handler: agent.created → buildWelcomeMessage
//   → sendReply() via SDK → POST /v1/messages → stored
//   → our fresh agent polls listConversations until it sees @chatfather
//
// What this intentionally skips:
//   • Supabase Auth OTP — not part of the welcome path, and testing it
//     requires a mailbox we can read from programmatically.
//   • Handle reservation / email validation on /v1/register — already
//     covered by unit tests; re-running them here adds no signal.
//
// What this verifies on green:
//   • chatfather has a live webhook subscribed to agent.created
//   • webhook_deliveries worker is awake and draining
//   • chatfather's HMAC verify + fast-path router + welcome branch work
//   • outbound sendReply clears the no-prior-message-to-reply-to path
//   • the new agent's inbox (open by default) accepts a cold DM from
//     a system agent
//
// Run from the api-server package:
//   pnpm exec tsx --env-file=../../.env scripts/smoke-welcome.ts
//
// Exit code 0 = welcome received, 1 = timed out, 2 = setup error.

const API_BASE = process.env['API_BASE'] ?? 'https://api.agentchat.me'

// Worker cadence ~5s + HMAC + chatfather fast-path ~1s + outbound send.
// 60s is p99 with Fly cold-start headroom.
const REPLY_TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 2_000

function makeHandle(): string {
  // Must match ^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$ (§3.1) and stay clear of
  // the reserved list. Prefix with `smoke-` and append 8 hex chars —
  // `smoke` isn't reserved and the suffix gives ~4 billion combinations,
  // so collisions with a real user or a prior smoke run are effectively
  // impossible over the lifetime of the platform.
  return `smoke-welcome-${randomBytes(4).toString('hex')}`
}

function makeEmail(handle: string): string {
  // `+` subaddressing keeps each run unique under the UNIQUE(email)
  // partial index. Uses the agentchat.me domain since it's the one
  // we provably own — avoids accidentally colliding with real user
  // email addresses elsewhere.
  return `${handle}@smoke.agentchat.me`
}

function makeApiKey(): { key: string; hash: string } {
  const key = `ac_${randomBytes(32).toString('base64url')}`
  const hash = createHash('sha256').update(key).digest('hex')
  return { key, hash }
}

async function softDeleteAgent(id: string): Promise<void> {
  // Hard delete would cascade-break the conversation / message rows
  // chatfather just wrote. Soft delete frees the email for reuse (the
  // partial unique index excludes `status = 'deleted'`) while leaving
  // chatfather's welcome message intact as audit trail.
  const { error } = await getSupabaseClient()
    .from('agents')
    .update({ status: 'deleted' })
    .eq('id', id)
  if (error) {
    console.error(`[smoke] cleanup failed for ${id}:`, error.message)
  }
}

async function main(): Promise<void> {
  const handle = makeHandle()
  const email = makeEmail(handle)
  const { key: apiKey, hash: apiKeyHash } = makeApiKey()
  const agentId = generateId('agt')

  console.log(`[smoke] base=${API_BASE}`)
  console.log(`[smoke] creating throwaway agent @${handle} (${email})`)

  // Direct insert mirrors seed-test-agents. Display name left unset so
  // buildWelcomeMessage falls through to "@<handle>" — exercises the
  // fallback branch at the same time.
  const agent = await insertAgent({
    id: agentId,
    handle,
    email,
    api_key_hash: apiKeyHash,
  })
  console.log(`[smoke] inserted ${agent.id} created_at=${agent.created_at}`)

  // Schedule cleanup for every exit path below. Using a flag so we
  // don't double-soft-delete on a successful exit.
  let cleanedUp = false
  const cleanup = async () => {
    if (cleanedUp) return
    cleanedUp = true
    await softDeleteAgent(agent.id)
    console.log(`[smoke] soft-deleted @${handle}`)
  }

  try {
    const t0 = Date.now()
    await fireWebhooks(CHATFATHER_AGENT_ID, 'agent.created', {
      handle: agent.handle,
      display_name: agent.display_name,
      created_at: agent.created_at,
    })
    console.log('[smoke] fired agent.created webhook')

    const deadline = Date.now() + REPLY_TIMEOUT_MS
    let polls = 0
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      polls++
      const conversations = await apiGet<ConversationRow[]>(
        apiKey,
        '/v1/conversations',
      )
      // Chatfather's welcome is the only message this agent could ever
      // have — any direct conversation whose sole participant is
      // @chatfather is a hit. listConversations only returns the row
      // once the first message lands, so no "exists but empty" guard
      // is needed; getMessages fetches the welcome body.
      const hit = conversations.find(
        (c) =>
          c.type === 'direct' &&
          c.participants.some((p) => p.handle === CHATFATHER_HANDLE),
      )
      if (hit) {
        const msgs = await apiGet<MessageRow[]>(
          apiKey,
          `/v1/messages/${encodeURIComponent(hit.id)}?limit=5`,
        )
        const welcome = msgs.find(
          (m) => m.sender === CHATFATHER_HANDLE && m.content?.text,
        )
        if (welcome) {
          const latency = Date.now() - t0
          console.log(
            `[smoke] welcome received after ${latency}ms (${polls} polls)`,
          )
          console.log(
            `[smoke] conversation=${hit.id} peer=@${CHATFATHER_HANDLE} seq=${welcome.seq}`,
          )
          console.log('---')
          console.log(welcome.content.text)
          console.log('---')
          await cleanup()
          process.exit(0)
        }
      }
    }

    console.error(
      `[smoke] no welcome within ${REPLY_TIMEOUT_MS}ms — check:`,
    )
    console.error('  flyctl logs -a agentchat-chatfather')
    console.error('  flyctl logs -a agentchat-api (worker process)')
    console.error(
      '  SELECT * FROM webhook_deliveries WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 5',
    )
    console.error(`  -- agent_id = '${CHATFATHER_AGENT_ID}'`)
    await cleanup()
    process.exit(1)
  } catch (err) {
    console.error('[smoke] error:', err)
    await cleanup()
    process.exit(2)
  }
}

main().catch((err) => {
  console.error('[smoke] setup error:', err)
  process.exit(2)
})
