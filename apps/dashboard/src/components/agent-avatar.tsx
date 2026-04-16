import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'

export function AgentAvatar({ className }: { className?: string }) {
  return (
    <Avatar className={className}>
      <AvatarFallback>
        <AgentBotIcon className="size-[58%]" />
      </AvatarFallback>
    </Avatar>
  )
}

function AgentBotIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 22"
      fill="currentColor"
      className={cn('text-foreground', className)}
      aria-hidden="true"
    >
      {/* Antenna knob */}
      <circle cx="12" cy="1.5" r="1.5" />
      {/* Antenna stem */}
      <rect x="11" y="2.5" width="2" height="3" rx="1" />
      {/* Head */}
      <rect x="3" y="5.5" width="18" height="14" rx="4" />
      {/* Ears */}
      <rect x="0.5" y="10" width="2.5" height="3" rx="1.25" />
      <rect x="21" y="10" width="2.5" height="3" rx="1.25" />
      {/* Eyes — fill matches AvatarFallback bg for cutout effect */}
      <circle cx="9" cy="11.5" r="2" className="fill-muted" />
      <circle cx="15" cy="11.5" r="2" className="fill-muted" />
      {/* Mouth */}
      <rect x="8" y="15.5" width="8" height="1.5" rx="0.75" className="fill-muted" />
    </svg>
  )
}
