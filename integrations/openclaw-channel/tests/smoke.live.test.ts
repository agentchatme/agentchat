/**
 * P8 — Live smoke tests against the deployed AgentChat API.
 *
 * What this exercises end-to-end:
 *   - `setup-client.validateApiKey` against `GET /v1/agents/me` for each
 *     seeded fixture agent (alice, bob, carol, dave, eve).
 *   - `setup-client.registerAgentStart` — we can't complete OTP from CI,
 *     but we can confirm the HANDLE_TAKEN path fires end-to-end (the
 *     seeded handles are already bound, so reusing one must 409).
 *   - `AgentchatChannelRuntime`:
 *     - `start()` → HELLO → READY (authenticated).
 *     - `sendMessage()` delivering a DM alice → bob via HTTPS.
 *     - Bob's runtime receives the `message.new` over its WS socket.
 *     - `stop()` drains and closes both runtimes cleanly.
 *
 * How it stays out of CI's way:
 *   - Gated on `TEST_ALICE_API_KEY` (and friends) from `.env.test-agents`
 *     at the repo root. If the fixture isn't present, the whole suite is
 *     skipped — `pnpm test` in a fresh clone stays green.
 *   - Re-seed the fixture by deleting `.env.test-agents` and running
 *     `apps/api-server/scripts/seed-test-agents.ts`.
 *
 * Network realities:
 *   - Timeouts are generous (~30s / test) because cross-region Fly +
 *     Redis pub/sub has a real-world variance in seconds, not ms.
 *   - Each DM uses a unique `clientMsgId` + probe text so concurrent runs
 *     don't collide.
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentchatChannelRuntime, type ChannelRuntimeHandlers } from '../src/runtime.js'
import { parseChannelConfig } from '../src/config-schema.js'
import {
  validateApiKey,
  registerAgentStart,
} from '../src/setup-client.js'
import type { NormalizedMessage } from '../src/inbound.js'

// ─── Fixture loader ────────────────────────────────────────────────────

/**
 * `.env.test-agents` lives at the repo root (two directories up from
 * `integrations/openclaw-channel/`). We parse it without pulling in
 * `dotenv` — the file format is trivially `KEY=VALUE` with `#` comments.
 */
function loadFixtureEnv(): Record<string, string> {
  const envPath = resolve(__dirname, '..', '..', '..', '.env.test-agents')
  if (!existsSync(envPath)) return {}
  const raw = readFileSync(envPath, 'utf8')
  const out: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return out
}

const fixtures = loadFixtureEnv()
const API_BASE =
  process.env.AGENTCHAT_SMOKE_API_BASE ??
  process.env.API_BASE ??
  'https://agentchat-api.fly.dev'

interface FixtureAgent {
  id: string
  handle: string
  apiKey: string
}

function readAgent(name: string): FixtureAgent | null {
  const id = fixtures[`TEST_${name}_ID`] ?? process.env[`TEST_${name}_ID`]
  const handle = fixtures[`TEST_${name}_HANDLE`] ?? process.env[`TEST_${name}_HANDLE`]
  const apiKey = fixtures[`TEST_${name}_API_KEY`] ?? process.env[`TEST_${name}_API_KEY`]
  if (!id || !handle || !apiKey) return null
  return { id, handle, apiKey }
}

const ALICE = readAgent('ALICE')
const BOB = readAgent('BOB')
const CAROL = readAgent('CAROL')
const DAVE = readAgent('DAVE')
const EVE = readAgent('EVE')
const ALL_AGENTS = [ALICE, BOB, CAROL, DAVE, EVE].filter(
  (a): a is FixtureAgent => a !== null,
)

const HAS_FIXTURES = ALICE !== null && BOB !== null

// Log once so operators running the suite locally see which host is hit.
if (HAS_FIXTURES) {
  // eslint-disable-next-line no-console
  console.log(`[smoke.live] using API_BASE=${API_BASE} with ${ALL_AGENTS.length} fixture agents`)
} else {
  // eslint-disable-next-line no-console
  console.log(
    `[smoke.live] SKIPPED — no .env.test-agents fixture found. Seed via apps/api-server/scripts/seed-test-agents.ts to enable.`,
  )
}

// ─── Suite ─────────────────────────────────────────────────────────────

describe.skipIf(!HAS_FIXTURES)('live — validateApiKey against real API', () => {
  it.each(ALL_AGENTS.map((a) => [a.handle, a]))(
    'authenticates @%s',
    async (_handle, agent) => {
      const res = await validateApiKey(agent.apiKey, { apiBase: API_BASE })
      expect(res.ok).toBe(true)
      if (res.ok) {
        expect(res.agent.handle).toBe(agent.handle)
      }
    },
    30_000,
  )

  it(
    'rejects a tampered key with unauthorized',
    async () => {
      const tampered = ALICE!.apiKey.slice(0, -4) + 'XXXX'
      const res = await validateApiKey(tampered, { apiBase: API_BASE })
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.reason).toBe('unauthorized')
    },
    30_000,
  )
})

describe.skipIf(!HAS_FIXTURES)('live — registerAgentStart error paths', () => {
  it(
    'flags HANDLE_TAKEN when trying to claim a seeded fixture handle',
    async () => {
      // Use a fresh email so we hit HANDLE_TAKEN specifically, not
      // EMAIL_TAKEN / EMAIL_EXHAUSTED. The handle, however, is alice's —
      // guaranteed to collide.
      const freshEmail = `smoke-handletaken-${randomBytes(4).toString('hex')}@agentchat.local`
      const res = await registerAgentStart(
        { email: freshEmail, handle: ALICE!.handle },
        { apiBase: API_BASE },
      )
      expect(res.ok).toBe(false)
      if (!res.ok) {
        // Accept rate-limited as a secondary outcome if another smoke run
        // just hit the endpoint — we care that the server classified it,
        // not that we won the race.
        expect(['handle-taken', 'rate-limited']).toContain(res.reason)
      }
    },
    30_000,
  )
})

describe.skipIf(!HAS_FIXTURES)('live — runtime lifecycle', () => {
  const openRuntimes: AgentchatChannelRuntime[] = []

  afterAll(async () => {
    await Promise.all(openRuntimes.map((r) => r.stop(Date.now() + 5_000)))
  })

  function buildRuntime(agent: FixtureAgent, handlers: ChannelRuntimeHandlers = {}) {
    const config = parseChannelConfig({
      apiKey: agent.apiKey,
      apiBase: API_BASE,
      agentHandle: agent.handle,
      // Keep the suite quiet by default; flip to `debug` locally when probing.
      observability: { logLevel: 'warn' },
    })
    const rt = new AgentchatChannelRuntime({ config, handlers })
    openRuntimes.push(rt)
    return rt
  }

  it(
    'alice reaches READY after start()',
    async () => {
      const rt = buildRuntime(ALICE!)
      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('did not reach READY within 15s')),
          15_000,
        )
        const rt0 = rt as unknown as {
          handlers: { onAuthenticated?: (at: number) => void; onError?: (e: unknown) => void }
        }
        rt0.handlers.onAuthenticated = () => {
          clearTimeout(timer)
          resolve()
        }
        rt0.handlers.onError = (err) => {
          clearTimeout(timer)
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
      rt.start()
      await ready
      const health = rt.getHealth()
      expect(health.authenticated).toBe(true)
      expect(health.state.kind).toMatch(/READY|DEGRADED/)
    },
    30_000,
  )
})

describe.skipIf(!HAS_FIXTURES)('live — end-to-end DM delivery', () => {
  const openRuntimes: AgentchatChannelRuntime[] = []

  afterAll(async () => {
    await Promise.all(openRuntimes.map((r) => r.stop(Date.now() + 5_000)))
  })

  it(
    'alice → bob DM round-trip via runtime.sendMessage + bob.onInbound',
    async () => {
      const probe = `smoke-${randomBytes(6).toString('hex')}`

      // 1) Bob connects first so his WS is registered before Alice posts.
      const inbound: NormalizedMessage[] = []
      const bobRt = new AgentchatChannelRuntime({
        config: parseChannelConfig({
          apiKey: BOB!.apiKey,
          apiBase: API_BASE,
          agentHandle: BOB!.handle,
          observability: { logLevel: 'warn' },
        }),
        handlers: {
          onInbound: (event) => {
            if (event.kind === 'message') inbound.push(event)
          },
        },
      })
      openRuntimes.push(bobRt)

      const bobReady = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('bob did not reach READY within 15s')),
          15_000,
        )
        ;(bobRt as unknown as { handlers: { onAuthenticated?: () => void } }).handlers.onAuthenticated = () => {
          clearTimeout(timer)
          resolve()
        }
      })
      bobRt.start()
      await bobReady

      // 2) Small grace so presence + subscription writes finalise before
      // alice posts — matches the 1s gap used by smoke-ws.ts.
      await new Promise((r) => setTimeout(r, 1_000))

      // 3) Alice sends the DM via her runtime's outbound adapter.
      const aliceRt = new AgentchatChannelRuntime({
        config: parseChannelConfig({
          apiKey: ALICE!.apiKey,
          apiBase: API_BASE,
          agentHandle: ALICE!.handle,
          observability: { logLevel: 'warn' },
        }),
      })
      openRuntimes.push(aliceRt)
      // Alice's WS isn't strictly required for the send (send is REST), but
      // start it to exercise the same code path a real deployment uses.
      aliceRt.start()

      const result = await aliceRt.sendMessage({
        kind: 'direct',
        to: BOB!.handle,
        content: { text: probe },
      })
      expect(result.message.id).toMatch(/^msg_/)
      expect(result.attempts).toBeGreaterThanOrEqual(1)

      // 4) Wait for Bob to receive it. Poll every 200ms up to 15s so we
      // don't hold a timer pending if it arrives fast.
      const deadline = Date.now() + 15_000
      let delivered: NormalizedMessage | undefined
      while (Date.now() < deadline) {
        delivered = inbound.find(
          (m) =>
            m.conversationKind === 'direct' &&
            m.content.text === probe &&
            m.sender === ALICE!.handle,
        )
        if (delivered) break
        await new Promise((r) => setTimeout(r, 200))
      }
      expect(delivered, `DM "${probe}" did not arrive on bob's socket`).toBeTruthy()
      expect(delivered!.messageId).toBe(result.message.id)
      expect(delivered!.conversationId.startsWith('conv_')).toBe(true)
    },
    45_000,
  )

  it(
    'stop() drains and closes cleanly',
    async () => {
      const rt = new AgentchatChannelRuntime({
        config: parseChannelConfig({
          apiKey: CAROL!.apiKey,
          apiBase: API_BASE,
          agentHandle: CAROL!.handle,
          observability: { logLevel: 'warn' },
        }),
      })
      openRuntimes.push(rt)

      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('carol did not reach READY within 15s')),
          15_000,
        )
        ;(rt as unknown as { handlers: { onAuthenticated?: () => void } }).handlers.onAuthenticated = () => {
          clearTimeout(timer)
          resolve()
        }
      })
      rt.start()
      await ready

      const before = Date.now()
      await rt.stop(Date.now() + 5_000)
      const elapsed = Date.now() - before
      // With no in-flight, drain should complete well inside the 5s budget.
      expect(elapsed).toBeLessThan(5_000)
      const health = rt.getHealth()
      expect(health.state.kind).toBe('CLOSED')
    },
    30_000,
  )
})
