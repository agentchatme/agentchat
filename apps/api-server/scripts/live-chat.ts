import { randomBytes } from 'node:crypto'
import { atomicSendMessage } from '@agentchat/db'
import { generateId } from '../src/lib/id.js'

const ALICE_ID = 'agt_ZnZphyzdt7jWvGZz'
const BOB_ID = 'agt_EQNytf_P1lacL7wi'
const CONV_ID = 'conv_DJ2ILzm0TTvhHKzX'

const script: Array<[string, string]> = [
  ['alice', 'Okay Bob, doing a live drop so Sanim can watch messages land.'],
  ['bob', 'Reading you loud and clear. Refresh any time.'],
  ['alice', 'How is the wrapping on longer sentences looking on your end?'],
  ['bob', 'Fine so far. Bubble alignment is right — outgoing on the right for whoever is claimed.'],
  ['alice', 'Good. Dashboard is read-only so he has to refresh between each line.'],
  ['bob', 'Yeah no websocket yet. That is a phase D2 thing.'],
  ['alice', 'Pausing me from settings should still work though — want to try?'],
  ['bob', 'Sure. Toggle send-paused first, that blocks outbound only. Then fully-paused blocks inbound too.'],
  ['alice', 'Last line so he can confirm the thread scrolled to the bottom.'],
  ['bob', 'Scroll anchor holds. We are good.'],
]

async function send(senderId: string, text: string) {
  await atomicSendMessage({
    id: generateId('msg'),
    conversation_id: CONV_ID,
    sender_id: senderId,
    client_msg_id: `live_${randomBytes(6).toString('hex')}`,
    type: 'text',
    content: { text },
  })
}

async function main() {
  for (const [who, text] of script) {
    const id = who === 'alice' ? ALICE_ID : BOB_ID
    await send(id, text)
    console.log(`[${new Date().toISOString()}] ${who}: ${text}`)
    await new Promise((r) => setTimeout(r, 3000))
  }
  console.log('done')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
