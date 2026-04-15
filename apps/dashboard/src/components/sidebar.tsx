'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  BookOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
} from 'lucide-react'

import type { ClaimedAgent, Owner } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Separator } from '@/components/ui/separator'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { AgentChatIcon } from '@/components/agentchat-icon'
import { AgentChatLogo } from '@/components/agentchat-logo'
import { ClaimAgentDialog } from '@/components/claim-agent-dialog'
import { SidebarAgentLink } from '@/components/sidebar-agent-link'
import {
  CollapsedAgentIcon,
  CollapsedAgentClaim,
  CollapsedIdentityDot,
  CollapsedNavButton,
  CollapsedNavLink,
  CollapsedThemeToggle,
  CollapsedSignOut,
} from '@/components/sidebar-collapsed'
import { SidebarNavLink } from '@/components/sidebar-nav-link'
import { OwnerMenuActions, OwnerIdentityCard } from '@/components/owner-menu'

// Sidebar layout (§3.1.2):
//
//   Top         — branding (logo + wordmark) + collapse toggle
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
// Collapsible rail (VSCode / Linear pattern): a chevron button at
// the top-right of the header flips the sidebar between the wide
// wordmark variant (288px / 320px on lg+) and a narrow 64px icon
// rail. In the rail variant, every affordance becomes an icon-only
// button with a hover tooltip; agent rows collapse to their avatar
// and the bottom nav becomes a stack of squares. State is persisted
// to localStorage so the choice survives a reload.
//
// The sidebar is now a client component because the collapse toggle
// owns state. That's fine: the `owner` and `agents` props are plain
// serialized data coming from the server shell in app-shell.tsx, so
// the boundary crossing is free.

const STORAGE_KEY = 'agentchat.sidebar.collapsed'

export function Sidebar({
  owner,
  agents,
}: {
  owner: Owner
  agents: ClaimedAgent[]
}) {
  // Default to expanded on first paint so SSR and the initial client
  // render agree; hydrate the actual preference from localStorage in
  // an effect to avoid a mismatch warning. The one-frame expanded
  // flash on a reload-as-collapsed is intentional and near-invisible.
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY)
      if (stored === '1') setCollapsed(true)
    } catch {
      // localStorage blocked (private mode etc.) — fall through.
    }
  }, [])

  function toggle() {
    setCollapsed((prev) => {
      const next = !prev
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
      } catch {
        // ignore write failures
      }
      return next
    })
  }

  return (
    <TooltipProvider delayDuration={150}>
      <aside
        className={cn(
          'bg-card hidden shrink-0 flex-col border-r transition-[width] duration-200 md:flex',
          collapsed ? 'w-16' : 'w-72 lg:w-80',
        )}
      >
        <div
          className={cn(
            'flex h-16 items-center',
            collapsed ? 'flex-col justify-center gap-2 px-0 py-2' : 'px-5',
          )}
        >
          {collapsed ? (
            // Size match: AgentChatLogo is rendered at h-7 (28px) in the
            // expanded header, and inside that lockup the bubble glyph
            // occupies 58/81 ≈ 71.6% of the height — about 20px. Render
            // the standalone icon at that same visual size so toggling
            // the rail doesn't cause the mark to appear to grow.
            <AgentChatIcon className="h-5 w-auto" />
          ) : (
            <>
              <AgentChatLogo className="h-7 w-auto" />
              <div className="ml-auto">
                <CollapseButton collapsed={collapsed} onClick={toggle} />
              </div>
            </>
          )}
        </div>
        {collapsed && (
          <div className="flex justify-center pb-2">
            <CollapseButton collapsed={collapsed} onClick={toggle} />
          </div>
        )}

        <Separator />

        {!collapsed && (
          <div className="flex items-center justify-between px-5 pt-5 pb-2">
            <span className="text-muted-foreground text-[11px] font-semibold tracking-wider uppercase">
              Agents
            </span>
            <span className="text-muted-foreground text-xs font-medium tabular-nums">
              {agents.length}
            </span>
          </div>
        )}

        <div
          className={cn(
            'flex min-h-0 flex-1 flex-col overflow-y-auto',
            collapsed ? 'items-center gap-1 px-2 pt-3 pb-3' : 'gap-1 px-3 pb-3',
          )}
        >
          {agents.length === 0 ? (
            collapsed ? null : (
              <p className="text-muted-foreground px-3 py-2 text-sm leading-relaxed">
                No claimed agents yet.
              </p>
            )
          ) : collapsed ? (
            agents.map((agent) => (
              <CollapsedAgentIcon key={agent.handle} agent={agent} />
            ))
          ) : (
            agents.map((agent) => (
              <SidebarAgentLink key={agent.handle} agent={agent} />
            ))
          )}
        </div>

        <Separator />

        <div className={cn(collapsed ? 'flex justify-center p-2' : 'p-3')}>
          {collapsed ? <CollapsedAgentClaim /> : <ClaimAgentDialog />}
        </div>

        <Separator />

        <nav
          className={cn(
            'flex flex-col gap-1',
            collapsed ? 'items-center p-2' : 'p-3',
          )}
        >
          {collapsed ? (
            <>
              <CollapsedNavLink
                href="/account"
                icon={<Settings className="size-[18px]" />}
                label="Account settings"
              />
              <CollapsedNavButton
                href="https://docs.agentchat.me"
                icon={<BookOpen className="size-[18px]" />}
                label="Documentation"
                external
              />
              <CollapsedThemeToggle />
              <CollapsedSignOut />
            </>
          ) : (
            <>
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
            </>
          )}
        </nav>

        <Separator />

        <div className={cn(collapsed ? 'flex justify-center p-2' : 'p-3')}>
          {collapsed ? (
            <CollapsedIdentityDot email={owner.email} />
          ) : (
            <OwnerIdentityCard email={owner.email} />
          )}
        </div>
      </aside>
    </TooltipProvider>
  )
}

function CollapseButton({
  collapsed,
  onClick,
}: {
  collapsed: boolean
  onClick: () => void
}) {
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose
  const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-8 items-center justify-center rounded-md transition-colors"
        >
          <Icon className="size-[18px]" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}
