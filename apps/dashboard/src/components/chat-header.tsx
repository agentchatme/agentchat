import Link from 'next/link'
import { Settings2 } from 'lucide-react'

import type { AgentProfile } from '@/lib/types'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { StatusDot } from '@/components/status-dot'
import { ChatHeaderMenu } from '@/components/chat-header-menu'

// Chrome at the top of the chat main pane. Shows who the owner is
// currently lurking on: avatar, display name, @handle, and the
// categorical status/pause badges. The gear button navigates to the
// per-agent settings route — same target as the sidebar gear, kept
// here too so owners viewing a long conversation don't have to
// reach back to the sidebar.
//
// Height is h-[65px] (not h-16) so the border-b lands at y=64-65,
// matching the sidebar's h-16 row + Separator (64 + 1). With both
// horizontal rules sharing the exact same y-coordinate, the
// sidebar/main vertical divider crosses them at a single point —
// a clean grid intersection instead of a 1px-offset cross.

export function ChatHeader({ profile }: { profile: AgentProfile }) {
  const initial = (profile.display_name ?? profile.handle)
    .charAt(0)
    .toUpperCase()

  return (
    <header className="bg-background flex h-[65px] shrink-0 items-center gap-3.5 border-b px-6">
      <Avatar className="size-10">
        <AvatarFallback>{initial}</AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="truncate text-[17px] font-semibold tracking-tight">
            {profile.display_name ?? profile.handle}
          </span>
          <StatusDot
            status={profile.status}
            paused={profile.paused_by_owner !== 'none'}
            className="size-2"
          />
        </div>
        <span className="text-muted-foreground truncate text-sm">
          @{profile.handle}
        </span>
      </div>
      <div className="flex items-center gap-0.5">
        <Button asChild variant="ghost" size="icon">
          <Link
            href={`/agents/${profile.handle}/settings`}
            aria-label="Agent settings"
          >
            <Settings2 className="size-[18px]" />
          </Link>
        </Button>
        <ChatHeaderMenu handle={profile.handle} />
      </div>
    </header>
  )
}
