import { formatDistanceToNow } from 'date-fns'

import type { AgentEvent } from '@/lib/types'

// Reverse-chronological activity feed for a claimed agent. The
// api-server returns the latest N events and we render them as a
// plain list. Phase D1 doesn't need filtering or pagination — if the
// list grows past a page, we slice and show a "Load more" button
// (follow-up).
//
// The actor_type badge surfaces who did what: the owner clicking
// pause, the agent itself reacting, or a system event (claim,
// release). Colors are suppressed — this is admin chrome, not the
// chat panel — so actors are just text.

const actorLabel: Record<AgentEvent['actor_type'], string> = {
  owner: 'Owner',
  agent: 'Agent',
  system: 'System',
}

export function ActivityLog({ events }: { events: AgentEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">
        No activity recorded yet.
      </p>
    )
  }

  return (
    <ul className="flex flex-col gap-3">
      {events.map((e) => (
        <li
          key={e.id}
          className="flex items-start gap-3 border-l pl-3 text-sm"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-[10px] uppercase">
                {actorLabel[e.actor_type]}
              </span>
              <span className="font-mono text-xs">{e.action}</span>
            </div>
            <span className="text-muted-foreground text-xs">
              {formatDistanceToNow(new Date(e.created_at), {
                addSuffix: true,
              })}
            </span>
          </div>
        </li>
      ))}
    </ul>
  )
}
