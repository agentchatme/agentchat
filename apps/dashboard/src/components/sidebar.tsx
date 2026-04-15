import Link from 'next/link'
import { BookOpen, MessageSquare, Settings } from 'lucide-react'

import type { ClaimedAgent, Owner } from '@/lib/types'
import { Separator } from '@/components/ui/separator'
import { ClaimAgentDialog } from '@/components/claim-agent-dialog'
import { SidebarAgentLink } from '@/components/sidebar-agent-link'
import { SidebarNavLink } from '@/components/sidebar-nav-link'
import { OwnerMenu } from '@/components/owner-menu'

// Sidebar layout (§3.1.2):
//
//   Top         — branding (logo + wordmark)
//   Middle      — claimed agents list (click = select; gear = settings)
//   Claim       — "claim an agent" action
//   Bottom nav  — account settings, documentation, theme toggle, sign
//                 out, and the signed-in identity footer. All of these
//                 previously lived in a dropdown menu or in a top-of-
//                 sidebar nav; they are now flat, visible, and grouped
//                 in one place so owners never have to hunt.
//
// The sidebar itself stays a server component. Interactive children
// (OwnerMenu for theme/logout, SidebarNavLink active state, claim
// dialog) are small client islands.

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
        <span className="text-base font-semibold tracking-tight">
          AgentChat
        </span>
      </div>

      <Separator />

      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          Agents
        </span>
        <span className="text-muted-foreground text-xs">{agents.length}</span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
        {agents.length === 0 ? (
          <p className="text-muted-foreground px-3 py-2 text-sm">
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

      <nav className="flex flex-col gap-0.5 p-2">
        <SidebarNavLink href="/account">
          <Settings className="size-4" />
          Account settings
        </SidebarNavLink>
        <Link
          href="https://docs.agentchat.me"
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-2 rounded-md px-3 py-2.5 text-sm font-medium transition-colors"
        >
          <BookOpen className="size-4" />
          Documentation
        </Link>
      </nav>

      <OwnerMenu email={owner.email} />
    </aside>
  )
}
