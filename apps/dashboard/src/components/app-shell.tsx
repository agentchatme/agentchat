import { Sidebar } from '@/components/sidebar'
import type { ClaimedAgent, Owner } from '@/lib/types'

// The admin shell — persistent sidebar on the left, swappable main
// pane on the right. This is a server component so the sidebar's
// agents list can render from the layout's fetch without a client
// round-trip. Interactive bits (claim dialog, pause buttons, theme
// toggle) live inside the sidebar's own client subtrees.
//
// The sidebar is a fixed 280px width on md+ screens and collapses
// to a top bar + drawer on small screens. Shape-wise this matches
// Vercel/Linear/Supabase admin panels — which is the §3.1.2 visual
// reference.

export function AppShell({
  owner,
  agents,
  children,
}: {
  owner: Owner
  agents: ClaimedAgent[]
  children: React.ReactNode
}) {
  return (
    <div className="bg-background flex min-h-dvh">
      <Sidebar owner={owner} agents={agents} />
      <main className="flex min-w-0 flex-1 flex-col">{children}</main>
    </div>
  )
}
