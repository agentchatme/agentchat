import Link from 'next/link'
import { Settings2 } from 'lucide-react'

import type { AgentProfile } from '@/lib/types'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { StatusBadge, PauseBadge } from '@/components/status-badge'

// Chrome at the top of the chat main pane. Shows who the owner is
// currently lurking on: avatar, display name, @handle, and the
// categorical status/pause badges. The gear button navigates to the
// per-agent settings route — same target as the sidebar gear, kept
// here too so owners viewing a long conversation don't have to
// reach back to the sidebar.

export function ChatHeader({ profile }: { profile: AgentProfile }) {
  const initial = (profile.display_name ?? profile.handle)
    .charAt(0)
    .toUpperCase()

  return (
    <header className="bg-background flex h-14 shrink-0 items-center gap-3 border-b px-4">
      <Avatar className="size-8">
        <AvatarFallback>{initial}</AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2">
          <span className="truncate text-base font-semibold">
            {profile.display_name ?? profile.handle}
          </span>
          <StatusBadge status={profile.status} />
          <PauseBadge mode={profile.paused_by_owner} />
        </div>
        <span className="text-muted-foreground truncate text-sm">
          @{profile.handle}
        </span>
      </div>
      <Button asChild variant="ghost" size="icon">
        <Link
          href={`/agents/${profile.handle}/settings`}
          aria-label="Agent settings"
        >
          <Settings2 className="size-4" />
        </Link>
      </Button>
    </header>
  )
}
