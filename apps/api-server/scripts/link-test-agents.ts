import { getSupabaseClient } from '@agentchat/db'
import { insertOwnerAgent, invalidateOwnerCache } from '@agentchat/db'

// One-off helper: claim the five seeded test agents under the dashboard
// owner that already claims an existing agent. Lets the fixture agents
// show up in the user's dashboard without a re-seed.
//
// Usage:
//   pnpm exec tsx --env-file=../../.env scripts/link-test-agents.ts
//
// Resolution strategy: the user already has prior test agents visible
// in their dashboard (seen in Fly logs as /dashboard/agents/alice-test-9e5a1a).
// Look up that agent's owner_id and apply it to the new five.

const KNOWN_OWNED_HANDLE = 'alice-test-9e5a1a' // any prior agent the user owns

const NEW_HANDLES = [
  'alice-test-35d437',
  'bob-test-3f5e50',
  'carol-test-d52581',
  'dave-test-d83d15',
  'eve-test-18baac',
]

async function main() {
  const supa = getSupabaseClient()

  // 1. Find the agent id for the known-owned handle
  const { data: known, error: knownErr } = await supa
    .from('agents')
    .select('id, handle')
    .eq('handle', KNOWN_OWNED_HANDLE)
    .single()
  if (knownErr || !known) {
    throw new Error(
      `Could not find anchor agent @${KNOWN_OWNED_HANDLE}: ${knownErr?.message ?? 'not found'}`,
    )
  }

  // 2. Find the owner that claims it
  const { data: claim, error: claimErr } = await supa
    .from('owner_agents')
    .select('owner_id')
    .eq('agent_id', known.id)
    .single()
  if (claimErr || !claim) {
    throw new Error(
      `@${KNOWN_OWNED_HANDLE} has no owner claim — pick a different anchor handle.`,
    )
  }
  const ownerId = claim.owner_id as string
  console.log(`✓ Anchor owner: ${ownerId} (via @${KNOWN_OWNED_HANDLE})`)

  // 3. For each new agent, look up its id and insert an owner_agents row
  for (const handle of NEW_HANDLES) {
    const { data: a, error: aErr } = await supa
      .from('agents')
      .select('id')
      .eq('handle', handle)
      .single()
    if (aErr || !a) {
      console.error(`✗ Skip @${handle}: ${aErr?.message ?? 'not found'}`)
      continue
    }
    const agentId = a.id as string

    // Skip if already claimed (idempotent re-runs)
    const { data: existing } = await supa
      .from('owner_agents')
      .select('owner_id')
      .eq('agent_id', agentId)
      .maybeSingle()
    if (existing) {
      console.log(`• @${handle} already claimed by ${existing.owner_id as string}`)
      continue
    }

    await insertOwnerAgent({ owner_id: ownerId, agent_id: agentId })
    await invalidateOwnerCache(agentId)
    console.log(`✓ Claimed @${handle} (${agentId}) for ${ownerId}`)
  }
}

main().catch((err) => {
  console.error('Link failed:', err)
  process.exit(1)
})
