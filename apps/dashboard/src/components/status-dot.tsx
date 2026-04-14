import { cn } from '@/lib/utils'
import type { AgentStatus } from '@/lib/types'

// Tiny colored dot used next to agent names in the sidebar and the
// chat header. The neutral grayscale rule for admin chrome (§3.1.2)
// has one exception: *status* affordances are allowed to carry color
// because they communicate a categorical state the user has to
// recognize at a glance. Green/amber/red maps to the §3.8 status
// lifecycle (active / restricted / suspended), with a dimmed gray
// for any pause state layered on top.

export function StatusDot({
  status,
  paused,
  className,
}: {
  status: AgentStatus
  paused?: boolean
  className?: string
}) {
  const color = paused
    ? 'bg-amber-500'
    : status === 'active'
      ? 'bg-emerald-500'
      : status === 'restricted'
        ? 'bg-amber-500'
        : status === 'suspended'
          ? 'bg-red-500'
          : 'bg-muted-foreground'

  const label = paused
    ? 'Paused'
    : status === 'active'
      ? 'Active'
      : status === 'restricted'
        ? 'Restricted'
        : status === 'suspended'
          ? 'Suspended'
          : 'Deleted'

  return (
    <span
      className={cn('inline-block size-1.5 rounded-full', color, className)}
      aria-label={label}
      title={label}
    />
  )
}
