import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { findAgentByHandle } from '@agentchat/db'
import { setAgentAvatar, buildAvatarUrl } from '../src/services/avatar.service.js'

// Admin one-off: set a system agent's avatar from a local image file.
//
// System agents (is_system = true) cannot use the public PUT
// /v1/agents/:handle/avatar because their API key only lives inside a
// sealed secrets store (Fly secrets on the consuming app). This script
// drives the same `setAgentAvatar` service function directly, so the
// pipeline — magic-byte sniff, sharp decode, 512 WebP, content-hash
// keying, prior-bytes cleanup — is identical to what the HTTP route
// does; no admin-only code path is introduced.
//
// Usage:
//   pnpm exec tsx --env-file=../../.env scripts/set-system-agent-avatar.ts \
//     <handle> <image-file>
//
// Example:
//   pnpm exec tsx --env-file=../../.env scripts/set-system-agent-avatar.ts \
//     chatfather /c/Users/arcan/Desktop/koku1.jpeg

async function main() {
  const [handle, filePath] = process.argv.slice(2)
  if (!handle || !filePath) {
    console.error('Usage: set-system-agent-avatar.ts <handle> <image-file>')
    process.exit(2)
  }

  const absPath = resolve(filePath)
  const bytes = await readFile(absPath)
  console.log(`[avatar] loaded ${bytes.length} bytes from ${absPath}`)

  const agent = await findAgentByHandle(handle)
  if (!agent) {
    console.error(`[avatar] agent @${handle} not found`)
    process.exit(1)
  }
  if (!agent.is_system) {
    console.error(
      `[avatar] @${handle} is not a system agent (is_system=false). ` +
        `Refusing to bypass the normal PUT /v1/agents/:handle/avatar path for a user-owned agent.`,
    )
    process.exit(1)
  }
  console.log(`[avatar] resolved @${handle} → ${agent.id} (is_system=true)`)

  const prior = agent.avatar_key as string | null | undefined
  if (prior) {
    console.log(`[avatar] prior key: ${prior}`)
    console.log(`[avatar] prior URL: ${buildAvatarUrl(prior)}`)
  } else {
    console.log('[avatar] no prior avatar set')
  }

  const result = await setAgentAvatar(agent.id, bytes)
  console.log('[avatar] upload ok')
  console.log(`[avatar] new key: ${result.avatar_key}`)
  console.log(`[avatar] new URL: ${result.avatar_url}`)

  // Read back so the operator sees the live DB state, not just the
  // in-memory return from the call above.
  const after = await findAgentByHandle(handle)
  if (!after || after.avatar_key !== result.avatar_key) {
    console.error('[avatar] post-write read-back mismatch — investigate')
    process.exit(1)
  }
  console.log('[avatar] read-back verified, avatar_key persisted on agents row')
}

main().catch((err) => {
  console.error('[avatar] failed:', err)
  process.exit(1)
})
