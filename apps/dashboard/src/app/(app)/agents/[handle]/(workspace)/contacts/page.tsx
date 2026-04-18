import { apiFetch, getAgentConversations } from '@/lib/api'
import type { AgentContactRow } from '@/lib/types'
import { AgentPeopleList, type PersonRow } from '@/components/agent-people-list'

// Contact-list workspace view. Rendered below the persistent
// ChatHeader (owned by the workspace layout), so the owner always
// knows which agent's contact book they're looking at. Read-only by
// construction (§3.1.2): the dashboard never mutates an agent's
// social graph, only observes it.
//
// Clicking a contact with an existing DM navigates to that thread;
// clicking a contact the agent hasn't messaged yet shows a "No
// messages yet" empty state. We build the peer-handle → DM id map
// here so the list component can render either affordance per row.
// getAgentConversations is request-scoped-deduped with the left
// column's call, so surfacing this second need doesn't add a
// round trip.

export default async function AgentContactsPage({
  params,
}: {
  params: Promise<{ handle: string }>
}) {
  const { handle } = await params
  const [{ contacts, total }, conversations] = await Promise.all([
    apiFetch<{ contacts: AgentContactRow[]; total: number }>(
      `/dashboard/agents/${handle}/contacts`,
    ),
    getAgentConversations(handle),
  ])

  // Map each peer handle the agent has a DM with to its conversation
  // id. Only direct (1:1) conversations contribute — group DMs don't
  // land on a single contact. A peer with multiple DMs is impossible
  // today (the server ensures one-DM-per-pair), but if that ever
  // changes, last-write-wins is fine.
  const dmByPeer = new Map<string, string>()
  for (const c of conversations) {
    if (c.type !== 'direct') continue
    const peer = c.participants[0]
    if (!peer) continue
    dmByPeer.set(peer.handle.toLowerCase(), c.id)
  }

  const rows: PersonRow[] = contacts.map((c) => ({
    handle: c.handle,
    display_name: c.display_name,
    avatar_url: c.avatar_url,
    meta: c.notes ?? c.description ?? null,
    timestamp: c.added_at,
    conversation_id: dmByPeer.get(c.handle.toLowerCase()) ?? null,
  }))

  return (
    <AgentPeopleList
      title="Contact list"
      variant="contacts"
      rows={rows}
      total={total}
      ownerHandle={handle}
    />
  )
}
