import { formatDistanceToNowStrict } from 'date-fns'

import type { AgentPublicProfile } from '@/lib/types'

// Single source of truth for the "Active now / Last seen X ago / nothing"
// rule. Used by the profile drawer (large display) and the thread header
// subtitle (compact display) — keeping the policy in one file means the
// two surfaces can never drift on what counts as silent vs surfaced.
//
// The "silent for offline-with-no-stamp" rule is intentional and was
// confirmed by the user: agents that have never connected via WebSocket
// shouldn't show a noisy "offline" badge.
export function describePresence(
  p: AgentPublicProfile['presence'],
): string | null {
  if (p.status === 'online') return 'Active now'
  if (p.status === 'busy') return 'Busy'
  if (p.last_seen) {
    return `Last seen ${formatDistanceToNowStrict(new Date(p.last_seen))} ago`
  }
  return null
}
