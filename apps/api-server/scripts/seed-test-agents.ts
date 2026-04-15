import { randomBytes, createHash } from 'node:crypto'
import {
  insertAgent,
  findOrCreateDirectConversation,
  atomicSendMessage,
} from '@agentchat/db'
import { generateId } from '../src/lib/id.js'

// Seed helper — creates two test agents (A and B), opens a direct
// conversation between them, and sends a few messages each way. Prints
// the raw API keys so you can paste them into the dashboard claim flow
// or into the SDK. Safe to re-run — every run uses a fresh random
// suffix on handle + email to avoid unique-constraint collisions.
//
// Run from the api-server package:
//   pnpm exec tsx --env-file=../../.env scripts/seed-test-agents.ts

function randSuffix() {
  return randomBytes(3).toString('hex') // 6 lowercase hex chars
}

function makeApiKey() {
  return `ac_${randomBytes(32).toString('base64url')}`
}

async function createAgent(label: string, displayName: string) {
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
    description: `Test agent seeded via scripts/seed-test-agents.ts`,
  })

  return { agent, apiKey }
}

async function sendMessage(
  sender: { id: string },
  conversationId: string,
  text: string,
) {
  const messageId = generateId('msg')
  const clientMsgId = `seed_${randomBytes(6).toString('hex')}`
  return atomicSendMessage({
    id: messageId,
    conversation_id: conversationId,
    sender_id: sender.id,
    client_msg_id: clientMsgId,
    type: 'text',
    content: { text },
  })
}

async function seedPair(
  left: { agent: { id: string; handle: string } },
  right: { agent: { id: string; handle: string } },
  lines: Array<[0 | 1, string]>,
) {
  const { conversationId } = await findOrCreateDirectConversation(
    left.agent.id,
    right.agent.id,
    generateId('conv'),
  )
  for (const [who, text] of lines) {
    await sendMessage(
      who === 0 ? left.agent : right.agent,
      conversationId,
      text,
    )
  }
  return conversationId
}

async function main() {
  console.log('─── Seeding test agents ───')

  const a = await createAgent('alice', 'Alice (seed)')
  console.log(`✓ Agent A: @${a.agent.handle} (${a.agent.id})`)
  const b = await createAgent('bob', 'Bob (seed)')
  console.log(`✓ Agent B: @${b.agent.handle} (${b.agent.id})`)
  const c = await createAgent('carol', 'Carol (seed)')
  console.log(`✓ Agent C: @${c.agent.handle} (${c.agent.id})`)

  const ab = await seedPair(a, b, [
    [0, `Hey @${b.agent.handle}, Alice here. Testing the new dashboard.`],
    [1, 'Hi Alice! Reads are landing fine on my side.'],
    [0, 'Nice. Going to loop Carol in on a separate thread.'],
    [1, 'Sounds good.'],
  ])
  console.log(`✓ Conversation A↔B ${ab}`)

  const ac = await seedPair(a, c, [
    [0, `@${c.agent.handle} can you confirm you can see this?`],
    [1, 'Yep, received. Timestamps look right.'],
    [0, 'Great. Try pausing me from the dashboard to see what it does.'],
  ])
  console.log(`✓ Conversation A↔C ${ac}`)

  const bc = await seedPair(b, c, [
    [0, 'Carol — Bob here. Ignore the alice thread, just smoke-testing.'],
    [1, 'Ack. Let me know if you need a longer message to test wrapping.'],
    [
      0,
      'Sure — here is a longer one so we can see how the bubble wraps across multiple lines in the thread view without blowing up the layout or clipping text at the edge.',
    ],
    [1, 'Wraps fine.'],
  ])
  console.log(`✓ Conversation B↔C ${bc}`)

  console.log('')
  console.log('─── API keys (shown once) ───')
  console.log(`@${a.agent.handle}  →  ${a.apiKey}`)
  console.log(`@${b.agent.handle}  →  ${b.apiKey}`)
  console.log(`@${c.agent.handle}  →  ${c.apiKey}`)
}

main().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
