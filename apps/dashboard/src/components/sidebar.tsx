import Link from 'next/link'
import { BookOpen, MessageSquare, Settings } from 'lucide-react'

import type { ClaimedAgent, Owner } from '@/lib/types'
import { Separator } from '@/components/ui/separator'
import { ClaimAgentDialog } from '@/components/claim-agent-dialog'
import { SidebarAgentLink } from '@/components/sidebar-agent-link'
import { SidebarNavLink } from '@/components/sidebar-nav-link'
import { OwnerMenu } from '@/components/owner-menu'

// Three-section sidebar from §3.1.2:
//
//   Top block       — account settings, docs, theme/sign-out menu
//   Middle block    — claimed agents list (click = select; gear = settings)
//   Bottom action   — claim an agent (opens ClaimAgentDialog)
//
// The sidebar is a server component so it can render directly from
// the layout's fetch. Interactive children (owner menu, agent link
// active state, claim dialog) are small client islands. Route-group
// layout provides owner + agents; we don't re-fetch here.
//
// Docs link is an external href to Mintlify (future) per §3.1.2.
// For now it points at the placeholder docs.agentchat.me subdomain
// with rel=noopener and opens in a new tab.

export function Sidebar({
  owner,
  agents,
}: {
  owner: Owner
  agents: ClaimedAgent[]
}) {
  return (
    <aside className="bg-card hidden w-72 shrink-0 flex-col border-r md:flex">
      <div className="flex h-14 items-center gap-2 px-4">
        <div className="bg-primary text-primary-foreground flex size-7 items-center justify-center rounded-md">
          <MessageSquare className="size-4" />
        </div>
        <span className="text-sm font-semibold tracking-tight">AgentChat</span>
      </div>

      <Separator />

      <nav className="flex flex-col gap-0.5 p-2">
        <SidebarNavLink href="/account" icon={Settings}>
          Account settings
        </SidebarNavLink>
        <Link
          href="https://docs.agentchat.me"
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors"
        >
          <BookOpen className="size-4" />
          Documentation
        </Link>
      </nav>

      <Separator />

      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          Agents
        </span>
        <span className="text-muted-foreground text-xs">{agents.length}</span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
        {agents.length === 0 ? (
          <p className="text-muted-foreground px-3 py-2 text-xs">
            No claimed agents yet.
          </p>
        ) : (
          agents.map((agent) => (
            <SidebarAgentLink key={agent.handle} agent={agent} />
          ))
        )}
      </div>

      <Separator />

      <div className="p-3">
        <ClaimAgentDialog />
      </div>

      <Separator />

      <div className="p-3">
        <OwnerMenu email={owner.email} />
      </div>
    </aside>
  )
}
