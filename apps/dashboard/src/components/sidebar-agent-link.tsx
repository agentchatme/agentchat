'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Settings2 } from 'lucide-react'

import type { ClaimedAgent } from '@/lib/types'
import { cn } from '@/lib/utils'
import { AgentAvatar } from '@/components/agent-avatar'
import { EffectiveStatusBadges } from '@/components/status-badge'

// One row per claimed agent. Click the row (outside the gear) to
// open the chat viewer for that agent. Click the gear to open the
// agent's settings route. Active state is pathname-derived:
//
//   /agents/:handle                         → chat row active
//   /agents/:handle/conversations/:convId   → chat row active
//   /agents/:handle/settings                → gear active
//
// Everything below is zinc/grayscale per §3.1.2 — no colored accent
// on selected rows, just a subtle bg lift. The status dot is the
// only colored affordance: green for active, amber for restricted,
// red for suspended.

export function SidebarAgentLink({ agent }: { agent: ClaimedAgent }) {
  const pathname = usePathname()
  const base = `/agents/${agent.handle}`
  const isSettings = pathname === `${base}/settings`
  const isChat =
    !isSettings && (pathname === base || pathname.startsWith(`${base}/`))

  return (
    <div
      className={cn(
        'group hover:bg-accent flex items-center gap-1 rounded-md pr-1.5 transition-colors',
        isChat && 'bg-accent',
      )}
    >
      <Link
        href={base}
        className="flex min-w-0 flex-1 items-center gap-3 px-2.5 py-2.5"
      >
        <AgentAvatar className="size-9" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold">
              {agent.display_name ?? agent.handle}
            </span>
            <EffectiveStatusBadges
              status={agent.status}
              pause={agent.paused_by_owner}
              className="text-[10px] px-1.5 py-0 leading-4"
            />
          </div>
          <span className="text-muted-foreground truncate text-[13px]">
            @{agent.handle}
          </span>
        </div>
      </Link>
      <Link
        href={`${base}/settings`}
        className={cn(
          'text-muted-foreground hover:text-foreground hover:bg-background flex size-8 items-center justify-center rounded-md transition-colors',
          isSettings && 'bg-background text-foreground',
        )}
        aria-label={`Settings for @${agent.handle}`}
      >
        <Settings2 className="size-4" />
      </Link>
    </div>
  )
}
