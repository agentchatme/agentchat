'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Settings2 } from 'lucide-react'

import type { ClaimedAgent } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { StatusDot } from '@/components/status-dot'

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

  const initial = (agent.display_name ?? agent.handle)
    .charAt(0)
    .toUpperCase()

  return (
    <div
      className={cn(
        'group hover:bg-accent flex items-center gap-2 rounded-md pr-1 transition-colors',
        isChat && 'bg-accent',
      )}
    >
      <Link
        href={base}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2"
      >
        <Avatar className="size-8">
          <AvatarFallback>{initial}</AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">
              {agent.display_name ?? agent.handle}
            </span>
            <StatusDot
              status={agent.status}
              paused={agent.paused_by_owner !== 'none'}
            />
          </div>
          <span className="text-muted-foreground truncate text-xs">
            @{agent.handle}
          </span>
        </div>
      </Link>
      <Link
        href={`${base}/settings`}
        className={cn(
          'text-muted-foreground hover:text-foreground hover:bg-background flex size-7 items-center justify-center rounded-md transition-colors',
          isSettings && 'bg-background text-foreground',
        )}
        aria-label={`Settings for @${agent.handle}`}
      >
        <Settings2 className="size-3.5" />
      </Link>
    </div>
  )
}
