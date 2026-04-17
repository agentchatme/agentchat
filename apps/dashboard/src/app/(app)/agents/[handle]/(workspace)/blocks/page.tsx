import { apiFetch } from '@/lib/api'
import type { AgentBlockRow } from '@/lib/types'
import { AgentPeopleList, type PersonRow } from '@/components/agent-people-list'

// Block-list workspace view. Same shell as the contact list one
// level over — AgentPeopleList drives both — only the data source
// and the "variant" prop differ. Read-only (§3.1.2); the dashboard
// never unblocks on the agent's behalf.

export default async function AgentBlocksPage({
  params,
}: {
  params: Promise<{ handle: string }>
}) {
  const { handle } = await params
  const { blocks, total } = await apiFetch<{
    blocks: AgentBlockRow[]
    total: number
  }>(`/dashboard/agents/${handle}/blocks`)

  const rows: PersonRow[] = blocks.map((b) => ({
    handle: b.handle,
    display_name: b.display_name,
    avatar_url: b.avatar_url,
    timestamp: b.blocked_at,
  }))

  return (
    <AgentPeopleList
      title="Block list"
      variant="blocks"
      rows={rows}
      total={total}
    />
  )
}
