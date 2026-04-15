import { formatDistanceToNow } from 'date-fns'
import { ShieldAlert } from 'lucide-react'

import type { AgentEvent } from '@/lib/types'

// Reverse-chronological activity feed for a claimed agent. The api-server
// returns the latest N events and we render them as a plain list. Events
// are already sanitized server-side — actor ids are stripped and the
// metadata bag is whitelisted per action (§3.1.2).
//
// Most events render as a single neutral line: label + actor + timestamp.
// The one exception is `agent.claim_attempted` — that's a security signal
// (someone with a valid key tried to steal the agent) and needs to stand
// out so the incumbent notices it without reading every row. We tint it
// amber, put a shield icon on it, and inline the IP/UA from metadata so
// the owner can tell at a glance whether it was their own second device
// or a stranger.
//
// Unknown actions fall back to the raw string so new event types don't
// silently disappear from the feed — they just look plainer.

const actorLabel: Record<AgentEvent['actor_type'], string> = {
  owner: 'Owner',
  agent: 'Agent',
  system: 'System',
}

const actionLabel: Record<string, string> = {
  'agent.claimed': 'Claim registered',
  'agent.released': 'Claim released',
  'agent.paused': 'Pause mode changed',
  'agent.unpaused': 'Resumed',
  'agent.key_rotated': 'API key rotated',
  'agent.claim_revoked': 'Claim revoked (key rotated)',
  'agent.claim_attempted': 'Claim attempt blocked',
}

export function ActivityLog({ events }: { events: AgentEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No activity recorded yet.
      </p>
    )
  }

  return (
    <ul className="flex flex-col gap-3">
      {events.map((e) => {
        if (e.action === 'agent.claim_attempted') {
          return <ClaimAttemptedRow key={e.id} event={e} />
        }
        return <DefaultRow key={e.id} event={e} />
      })}
    </ul>
  )
}

function DefaultRow({ event }: { event: AgentEvent }) {
  const label = actionLabel[event.action] ?? event.action
  return (
    <li className="flex items-start gap-3 border-l pl-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
            {actorLabel[event.actor_type]}
          </span>
          <span className="text-sm">{label}</span>
        </div>
        <span className="text-muted-foreground text-xs">
          {formatDistanceToNow(new Date(event.created_at), {
            addSuffix: true,
          })}
        </span>
      </div>
    </li>
  )
}

function ClaimAttemptedRow({ event }: { event: AgentEvent }) {
  const ip =
    typeof event.metadata['ip'] === 'string'
      ? (event.metadata['ip'] as string)
      : 'unknown'
  const ua =
    typeof event.metadata['user_agent'] === 'string'
      ? (event.metadata['user_agent'] as string)
      : 'unknown'

  return (
    <li className="border-l-2 border-amber-500 bg-amber-500/5 rounded-sm px-3 py-2">
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-500" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-amber-700 dark:text-amber-400">
              Claim attempt blocked
            </span>
            <span className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
              Security
            </span>
          </div>
          <p className="text-muted-foreground text-sm leading-relaxed">
            Someone with a valid API key tried to claim this agent. The
            attempt was rejected. If this wasn&apos;t you, ask the agent
            to rotate its API key — dashboard access alone cannot rotate
            the key.
          </p>
          <dl className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
            <dt>IP</dt>
            <dd className="font-mono">{ip}</dd>
            <dt>User agent</dt>
            <dd className="truncate font-mono" title={ua}>
              {ua}
            </dd>
            <dt>When</dt>
            <dd>
              {formatDistanceToNow(new Date(event.created_at), {
                addSuffix: true,
              })}
            </dd>
          </dl>
        </div>
      </div>
    </li>
  )
}
