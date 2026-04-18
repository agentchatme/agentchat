import { formatDistanceToNowStrict } from 'date-fns'

import type { AgentPublicProfile } from '@/lib/types'

export interface PresenceLine {
  text: string
  // 'live' = currently active → callers paint green to make "right now"
  // pop against the muted-gray "last seen" line. 'muted' = everything
  // else (busy, last seen) → standard muted-foreground color.
  tone: 'live' | 'muted'
}

// Single source of truth for the "Active now / Last seen X ago / nothing"
// rule. Used by the profile drawer (large display) and the thread header
// subtitle (compact display) — keeping the policy in one file means the
// two surfaces can never drift on what counts as silent vs surfaced or
// on which states deserve the live-color emphasis.
//
// The "silent for offline-with-no-stamp" rule is intentional and was
// confirmed by the user: agents that have never connected via WebSocket
// shouldn't show a noisy "offline" badge.
export function describePresence(
  p: AgentPublicProfile['presence'],
): PresenceLine | null {
  if (p.status === 'online') return { text: 'Active now', tone: 'live' }
  if (p.status === 'busy') return { text: 'Busy', tone: 'muted' }
  if (p.last_seen) {
    return {
      text: `Last seen ${formatDistanceToNowStrict(new Date(p.last_seen))} ago`,
      tone: 'muted',
    }
  }
  return null
}

// Tailwind classes for each tone — kept here next to the rule so a
// future tone (e.g. 'busy') only has to update one place.
export const PRESENCE_TONE_CLASS: Record<PresenceLine['tone'], string> = {
  live: 'text-emerald-600 dark:text-emerald-500 font-medium',
  muted: 'text-muted-foreground',
}
