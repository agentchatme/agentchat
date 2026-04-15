import type { AgentStatus, PauseMode } from '@/lib/types'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

// Text badges for the agent overview + per-agent settings routes.
// Mirrors the colors used by StatusDot — same state, different form
// factor. The pause badge uses the §3.1.1 labels verbatim ("Send
// paused" / "Fully paused") so owners see consistent wording across
// the plan file, the api-server error messages, and the UI.

export function StatusBadge({
  status,
  className,
}: {
  status: AgentStatus
  className?: string
}) {
  const label =
    status === 'active'
      ? 'Active'
      : status === 'restricted'
        ? 'Restricted'
        : status === 'suspended'
          ? 'Suspended'
          : 'Deleted'

  const tone =
    status === 'active'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
      : status === 'restricted'
        ? 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400'
        : status === 'suspended'
          ? 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400'
          : 'border-muted-foreground/30 bg-muted text-muted-foreground'

  return (
    <Badge variant="outline" className={cn(tone, className)}>
      {label}
    </Badge>
  )
}

export function PauseBadge({
  mode,
  className,
}: {
  mode: PauseMode
  className?: string
}) {
  if (mode === 'none') return null
  const label = mode === 'send' ? 'Send paused' : 'Fully paused'
  return (
    <Badge
      variant="outline"
      className={cn(
        'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
        className,
      )}
    >
      {label}
    </Badge>
  )
}

// Effective agent state — collapses the orthogonal lifecycle/pause
// dimensions into one visually coherent row. `status` is the platform
// lifecycle (active / restricted / suspended), `pause` is the owner
// override. The naive pair renders "Active + Fully paused" side by
// side which reads as a contradiction — owners who pause expect the
// UI to acknowledge the pause. Rule:
//
//   active + paused     → show only the PauseBadge
//   not-active + paused → show both (restricted/suspended is info the
//                         owner still needs to see even while paused)
//   paused = none       → show only the StatusBadge
//
// Used by the agent settings Status field and the chat header.
export function EffectiveStatusBadges({
  status,
  pause,
  className,
}: {
  status: AgentStatus
  pause: PauseMode
  className?: string
}) {
  const hideStatus = status === 'active' && pause !== 'none'
  return (
    <>
      {!hideStatus && <StatusBadge status={status} className={className} />}
      <PauseBadge mode={pause} className={className} />
    </>
  )
}
