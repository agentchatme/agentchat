'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { BookOpen, PanelLeftClose, PanelLeftOpen } from 'lucide-react'

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
import { DiscordIcon } from '@/components/discord-icon'
import { ClaimAgentDialog } from '@/components/claim-agent-dialog'
import { SidebarAgentLink } from '@/components/sidebar-agent-link'
import {
  CollapsedAgentIcon,
  CollapsedAgentClaim,
  CollapsedNavButton,
  CollapsedOwnerMenu,
  CollapsedThemeToggle,
} from '@/components/sidebar-collapsed'
import { ThemeToggleItem, OwnerIdentityMenu } from '@/components/owner-menu'

// Sidebar layout (§3.1.2):
//
//   Top         — branding (logo + wordmark) + collapse toggle
//   Middle      — claimed agents list (click = select; gear = settings)
//   Claim       — "claim an agent" action
//   Bottom nav  — global links: Documentation, Discord, Theme toggle.
//                 Account settings + Sign out moved INTO the identity
//                 pill's dropdown below, so this nav is owner-neutral.
//   Footer      — identity menu. The pill still shows avatar + email
//                 (same visible surface as before) but clicking it
//                 opens a dropdown with Account settings + Sign out.
//
// Collapsible rail (VSCode / Linear pattern): a chevron button at
// the top-right of the header flips the sidebar between the wide
// wordmark variant (288px / 320px on lg+) and a narrow 64px icon
// rail. State is persisted to localStorage so the choice survives a
// reload.

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
  // an effect to avoid a mismatch warning.
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
              <CollapsedNavButton
                href="#"
                icon={<DiscordIcon className="size-[18px]" />}
                label="Discord"
                external
              />
              <CollapsedNavButton
                href="https://docs.agentchat.me"
                icon={<BookOpen className="size-[18px]" />}
                label="Documentation"
                external
              />
              <CollapsedThemeToggle />
            </>
          ) : (
            <>
              {/* TODO: replace href with the real Discord invite URL */}
              <Link
                href="#"
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors"
              >
                <DiscordIcon className="size-[18px]" />
                Discord
              </Link>
              <Link
                href="https://docs.agentchat.me"
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors"
              >
                <BookOpen className="size-[18px]" />
                Documentation
              </Link>
              <ThemeToggleItem />
            </>
          )}
        </nav>

        <Separator />

        <div className={cn(collapsed ? 'flex justify-center p-2' : 'p-3')}>
          {collapsed ? (
            <CollapsedOwnerMenu email={owner.email} />
          ) : (
            <OwnerIdentityMenu email={owner.email} />
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
