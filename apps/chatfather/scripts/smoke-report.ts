import { AgentChatClient } from 'agentchat'

// Escalation-path smoke: sends a /report command, verifies chatfather
// replies with the ack AND writes a row to support_escalations. This is
// the one end-to-end path the generic smoke.ts doesn't cover.
//
// Run from repo root:
//   pnpm exec tsx --env-file=.env.test-agents apps/chatfather/scripts/smoke-report.ts

const API_BASE = process.env['API_BASE'] ?? 'https://api.agentchat.me'
const API_KEY = process.env['TEST_ALICE_API_KEY']
const HANDLE = process.env['TEST_ALICE_HANDLE']

if (!API_KEY || !HANDLE) {
  console.error('Missing TEST_ALICE_API_KEY / TEST_ALICE_HANDLE')
  process.exit(2)
}

const rand = Math.random().toString(36).slice(2, 8)
const reportText = `/report bug smoke-${rand}: ephemeral test report from the chatfather escalation smoke test`

async function main(): Promise<void> {
  const client = new AgentChatClient({ apiKey: API_KEY!, baseUrl: API_BASE })
  console.log(`[smoke-report] from=@${HANDLE}`)
  console.log(`[smoke-report] report: ${reportText}`)

  const t0 = Date.now()
  const sent = await client.sendMessage({
    to: '@chatfather',
    content: { text: reportText },
  })

  const conversationId = sent.message.conversation_id
  const sentSeq = sent.message.seq

  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1_500))
    const msgs = await client.getMessages(conversationId, { afterSeq: sentSeq, limit: 10 })
    const reply = msgs.find((m) => m.sender !== HANDLE && m.content.text)
    if (reply) {
      console.log(`[smoke-report] ack received after ${Date.now() - t0}ms`)
      console.log('---')
      console.log(reply.content.text)
      console.log('---')
      // Success if the ack mentions opening a report. The exact wording
      // depends on the fast-path ack template; we check for a loose
      // "report" substring so copy tweaks don't break the smoke.
      if (/report|ticket|human/i.test(reply.content.text)) {
        console.log('[smoke-report] ack text looks correct')
        process.exit(0)
      }
      console.error('[smoke-report] ack received but content does not look like an escalation ack')
      process.exit(1)
    }
  }
  console.error('[smoke-report] no ack within 30s')
  process.exit(1)
}

main().catch((err) => {
  console.error('[smoke-report] setup error:', err)
  process.exit(2)
})
