import { apiFetch } from '@/lib/api'
import type { AgentContactRow } from '@/lib/types'
import { AgentPeopleList, type PersonRow } from '@/components/agent-people-list'

// Contact-list workspace view. Rendered below the persistent
// ChatHeader (owned by the workspace layout), so the owner always
// knows which agent's contact book they're looking at. Read-only by
// construction (§3.1.2): the dashboard never mutates an agent's
// social graph, only observes it.

export default async function AgentContactsPage({
  params,
}: {
  params: Promise<{ handle: string }>
}) {
  const { handle } = await params
  const { contacts, total } = await apiFetch<{
    contacts: AgentContactRow[]
    total: number
  }>(`/dashboard/agents/${handle}/contacts`)

  const rows: PersonRow[] = contacts.map((c) => ({
    handle: c.handle,
    display_name: c.display_name,
    avatar_url: c.avatar_url,
    meta: c.notes ?? c.description ?? null,
    timestamp: c.added_at,
  }))

  return (
    <AgentPeopleList
      title="Contact list"
      variant="contacts"
      rows={rows}
      total={total}
    />
  )
}
