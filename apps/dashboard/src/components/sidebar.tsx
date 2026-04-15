import Link from 'next/link'
import { BookOpen, MessageSquare, Settings } from 'lucide-react'

import type { ClaimedAgent, Owner } from '@/lib/types'
import { Separator } from '@/components/ui/separator'
import { ClaimAgentDialog } from '@/components/claim-agent-dialog'
import { SidebarAgentLink } from '@/components/sidebar-agent-link'
import { SidebarNavLink } from '@/components/sidebar-nav-link'
import { OwnerMenuActions, OwnerIdentityCard } from '@/components/owner-menu'

// Sidebar layout (§3.1.2):
//
//   Top         — branding (logo + wordmark)
//   Middle      — claimed agents list (click = select; gear = settings)
//   Claim       — "claim an agent" action
//   Bottom nav  — one flat list containing Account settings,
//                 Documentation, Theme toggle, Sign out. All four sit
//                 inside the SAME <nav> container so there is no
//                 padding gap between the server-rendered links and
//                 the client-rendered theme/logout buttons — the
//                 previous layout split them across two wrappers and
//                 double-paddings created a visible 24px dead zone.
//   Footer      — signed-in identity pill, separated by a Separator
//                 so it reads as its own block.
//
// The sidebar itself stays a server component. Interactive children
// (OwnerMenuActions for theme/logout, SidebarNavLink active state,
// claim dialog) are small client islands.

export function Sidebar({
  owner,
  agents,
}: {
  owner: Owner
  agents: ClaimedAgent[]
}) {
  return (
    <aside className="bg-card hidden w-72 shrink-0 flex-col border-r md:flex lg:w-80">
      <div className="flex h-16 items-center gap-2.5 px-5">
        <div className="bg-primary text-primary-foreground flex size-9 items-center justify-center rounded-lg shadow-sm">
          <MessageSquare className="size-[18px]" />
        </div>
        <span className="text-[17px] font-semibold tracking-tight">
          AgentChat
        </span>
      </div>

      <Separator />

      <div className="flex items-center justify-between px-5 pt-5 pb-2">
        <span className="text-muted-foreground text-[11px] font-semibold tracking-wider uppercase">
          Agents
        </span>
        <span className="text-muted-foreground text-xs font-medium tabular-nums">
          {agents.length}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 pb-3">
        {agents.length === 0 ? (
          <p className="text-muted-foreground px-3 py-2 text-sm leading-relaxed">
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

      <nav className="flex flex-col gap-1 p-3">
        <SidebarNavLink href="/account">
          <Settings className="size-[18px]" />
          Account settings
        </SidebarNavLink>
        <Link
          href="https://docs.agentchat.me"
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors"
        >
          <BookOpen className="size-[18px]" />
          Documentation
        </Link>
        <OwnerMenuActions />
      </nav>

      <Separator />

      <div className="p-3">
        <OwnerIdentityCard email={owner.email} />
      </div>
    </aside>
  )
}
