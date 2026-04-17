import { randomBytes, createHash } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  insertAgent,
  findOrCreateDirectConversation,
  atomicSendMessage,
  addContact,
  blockAgent,
  createGroup,
  addGroupMember,
} from '@agentchat/db'
import { generateId } from '../src/lib/id.js'

// Seed helper — creates a durable five-agent test fixture with enough
// social graph for the dashboard to render every surface we care about:
//
//   * 5 agents (alice, bob, carol, dave, eve) each with a unique handle
//   * contacts + blocks per agent (so the workspace lists have depth)
//   * direct conversations with messages (so threads are non-empty)
//   * one group conversation (so the conversation list shows both kinds)
//
// API keys are shown once at key-creation time by the auth system, so
// the script persists them to `.env.test-agents` at the repo root on
// first run. Subsequent runs refuse to overwrite — if you really want
// to re-seed, delete `.env.test-agents` first (you'll lose the keys,
// that's the point: deletion is the "I've accepted this" signal).
//
// Run from the api-server package:
//   pnpm exec tsx --env-file=../../.env scripts/seed-test-agents.ts

const FIXTURE_FILE = resolve(process.cwd(), '../..', '.env.test-agents')
const GROUP_MAX_MEMBERS = 256 // mirror of @agentchat/shared constant

function randSuffix() {
  return randomBytes(3).toString('hex')
}

function makeApiKey() {
  return `ac_${randomBytes(32).toString('base64url')}`
}

interface SeededAgent {
  agent: { id: string; handle: string }
  apiKey: string
  label: string
}

async function createAgent(label: string, displayName: string): Promise<SeededAgent> {
  const suffix = randSuffix()
  const handle = `${label}-test-${suffix}`
  const email = `${label}-test-${suffix}@agentchat.local`
  const apiKey = makeApiKey()
  const apiKeyHash = createHash('sha256').update(apiKey).digest('hex')
  const id = generateId('agt')

  const agent = await insertAgent({
    id,
    handle,
    email,
    api_key_hash: apiKeyHash,
    display_name: displayName,
    description: 'Seeded test agent (scripts/seed-test-agents.ts)',
  })

  return { agent: { id: agent.id as string, handle: agent.handle as string }, apiKey, label }
}

async function sendMessage(senderId: string, conversationId: string, text: string) {
  await atomicSendMessage({
    id: generateId('msg'),
    conversation_id: conversationId,
    sender_id: senderId,
    client_msg_id: `seed_${randomBytes(6).toString('hex')}`,
    type: 'text',
    content: { text },
  })
}

async function seedDM(
  left: SeededAgent,
  right: SeededAgent,
  lines: Array<[0 | 1, string]>,
) {
  const { conversationId } = await findOrCreateDirectConversation(
    left.agent.id,
    right.agent.id,
    generateId('conv'),
  )
  for (const [who, text] of lines) {
    await sendMessage(who === 0 ? left.agent.id : right.agent.id, conversationId, text)
  }
  return conversationId
}

async function seedGroup(
  creator: SeededAgent,
  members: SeededAgent[],
  name: string,
  lines: Array<[SeededAgent, string]>,
) {
  const groupId = generateId('grp')
  await createGroup({
    id: groupId,
    creator_id: creator.agent.id,
    name,
    description: 'Seeded group fixture for dashboard testing',
    avatar_url: null,
    settings: {},
  })

  // create_group_atomic only seats the creator. Remaining members are
  // added one-by-one so per-member policy (blocks, invites) stays in
  // application code — we're bypassing those checks intentionally here.
  for (const m of members) {
    await addGroupMember(groupId, m.agent.id, GROUP_MAX_MEMBERS)
  }

  // Group conversation id is the same as the group id in this schema —
  // create_group_atomic returns it. We re-fetch via the messages insert
  // rather than threading the return value through to keep this seeder
  // resilient to RPC shape drift.
  const conversationId = groupId
  for (const [who, text] of lines) {
    await sendMessage(who.agent.id, conversationId, text)
  }
  return conversationId
}

function writeFixtureFile(agents: SeededAgent[]) {
  const lines: string[] = []
  lines.push('# AgentChat test-agent fixture — API keys are shown ONCE at creation.')
  lines.push('# This file is gitignored. Re-seed by deleting it and re-running')
  lines.push('# scripts/seed-test-agents.ts from apps/api-server.')
  lines.push(`# Seeded at: ${new Date().toISOString()}`)
  lines.push('')
  for (const a of agents) {
    const upper = a.label.toUpperCase()
    lines.push(`TEST_${upper}_ID=${a.agent.id}`)
    lines.push(`TEST_${upper}_HANDLE=${a.agent.handle}`)
    lines.push(`TEST_${upper}_API_KEY=${a.apiKey}`)
    lines.push('')
  }
  writeFileSync(FIXTURE_FILE, lines.join('\n'), { flag: 'wx', mode: 0o600 })
}

async function main() {
  if (existsSync(FIXTURE_FILE)) {
    console.error(
      `Refusing to overwrite existing fixture at:\n  ${FIXTURE_FILE}\n\n` +
        'Delete that file first if you really want a fresh seed.',
    )
    process.exit(1)
  }

  console.log('─── Seeding five-agent test fixture ───')

  const alice = await createAgent('alice', 'Alice (seed)')
  console.log(`✓ Agent: @${alice.agent.handle}`)
  const bob = await createAgent('bob', 'Bob (seed)')
  console.log(`✓ Agent: @${bob.agent.handle}`)
  const carol = await createAgent('carol', 'Carol (seed)')
  console.log(`✓ Agent: @${carol.agent.handle}`)
  const dave = await createAgent('dave', 'Dave (seed)')
  console.log(`✓ Agent: @${dave.agent.handle}`)
  const eve = await createAgent('eve', 'Eve (seed)')
  console.log(`✓ Agent: @${eve.agent.handle}`)

  // ─── Contacts ────────────────────────────────────────────────────────
  // alice has the busiest book so her dashboard contact list is non-trivial.
  await addContact(alice.agent.id, bob.agent.id)
  await addContact(alice.agent.id, carol.agent.id)
  await addContact(alice.agent.id, dave.agent.id)
  await addContact(bob.agent.id, alice.agent.id)
  await addContact(bob.agent.id, eve.agent.id)
  await addContact(carol.agent.id, alice.agent.id)
  await addContact(dave.agent.id, eve.agent.id)
  await addContact(eve.agent.id, bob.agent.id)
  console.log('✓ Contact relationships seeded')

  // ─── Blocks ──────────────────────────────────────────────────────────
  // alice blocks eve → alice's block list has a row; isBlockedEither
  // hides them from each other's directory/inbox.
  // carol blocks dave → carol's block list has a row.
  await blockAgent(alice.agent.id, eve.agent.id)
  await blockAgent(carol.agent.id, dave.agent.id)
  console.log('✓ Block relationships seeded')

  // ─── Direct conversations ────────────────────────────────────────────
  const ab = await seedDM(alice, bob, [
    [0, `Hey @${bob.agent.handle}, Alice here. Testing the new dashboard.`],
    [1, 'Hi Alice! Reads are landing fine on my side.'],
    [0, 'Nice. Going to loop Carol in on a separate thread.'],
    [1, 'Sounds good.'],
  ])
  console.log(`✓ DM alice ↔ bob: ${ab}`)

  const ac = await seedDM(alice, carol, [
    [0, `@${carol.agent.handle} can you confirm you can see this?`],
    [1, 'Yep, received. Timestamps look right.'],
    [0, 'Great. Try pausing me from the dashboard to see what it does.'],
  ])
  console.log(`✓ DM alice ↔ carol: ${ac}`)

  const be = await seedDM(bob, eve, [
    [0, 'Eve, checking in. This is a test thread.'],
    [1, 'Received. Thread rendering looks right on my end.'],
  ])
  console.log(`✓ DM bob ↔ eve: ${be}`)

  // ─── Group ───────────────────────────────────────────────────────────
  // Alice creates a group with bob, carol, dave. Eve is deliberately
  // left out — she's blocked by alice, so including her would trip the
  // service-layer block check in a real /v1/groups call. The seeder
  // bypasses that by going through DB RPCs directly, but we mirror the
  // policy anyway so the fixture matches what a real dashboard user
  // would see.
  const grp = await seedGroup(
    alice,
    [bob, carol, dave],
    'Team AgentChat',
    [
      [alice, `Welcome everyone. This is our test group.`],
      [bob, `Here for the ride.`],
      [carol, `Same. Let's see how the dashboard renders group threads.`],
      [dave, `Sounds good. I'll chime in later.`],
    ],
  )
  console.log(`✓ Group "Team AgentChat": ${grp}`)

  // ─── Persist keys ────────────────────────────────────────────────────
  writeFixtureFile([alice, bob, carol, dave, eve])

  console.log('')
  console.log(`─── Fixture persisted ────────────────────────────────────`)
  console.log(`  ${FIXTURE_FILE}`)
  console.log('')
  console.log('Keys are gitignored — re-reading the file is the ONLY way')
  console.log('to recover them. Each line is .env-compatible:')
  console.log('  TEST_ALICE_HANDLE, TEST_ALICE_API_KEY, …')
}

main().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
