import {
  differenceInCalendarDays,
  format,
  isSameDay,
  isToday,
  isYesterday,
} from 'date-fns'

import type { DashboardMessage } from '@/lib/types'
import { MessageBubble } from '@/components/message-bubble'

// Vertical stack of message bubbles for one conversation. The API
// returns messages in ascending seq order (oldest first, newest
// last), so we render them straight through and let the flex column
// grow downward. We scroll the container, not the page, so the
// sidebar, chat header, and thread header stay fixed.
//
// Two presentation layers on top of the raw list:
//   1. Date dividers between messages from different calendar days,
//      matching WhatsApp Desktop's "Today / Yesterday / Monday /
//      12/04/2026" pills.
//   2. Consecutive-message grouping: when two adjacent messages
//      share a sender and sit within GROUP_WINDOW_MS, the tail of
//      the first and the top of the second are flattened so a burst
//      reads as one cluster instead of four identical bubbles.
//
// The chat viewer is read-only (§3.1.2): no composer, no send
// button, no typing indicators. This component is deliberately just
// a list — there's no input anywhere on the route, by design.

const GROUP_WINDOW_MS = 5 * 60 * 1000

export function MessageThread({
  messages,
}: {
  messages: DashboardMessage[]
}) {
  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-10">
        <p className="text-chat-meta text-sm">
          No messages in this conversation yet.
        </p>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto">
      <div className="mx-auto flex w-full max-w-4xl flex-col px-6 py-6">
        {messages.map((m, i) => {
          const prev = i > 0 ? messages[i - 1] : null
          const next = i < messages.length - 1 ? messages[i + 1] : null
          const showDivider =
            !prev || !isSameDay(new Date(prev.created_at), new Date(m.created_at))
          const groupedWithPrev =
            !showDivider &&
            !!prev &&
            prev.is_own === m.is_own &&
            withinWindow(prev.created_at, m.created_at)
          const groupedWithNext =
            !!next &&
            isSameDay(new Date(m.created_at), new Date(next.created_at)) &&
            next.is_own === m.is_own &&
            withinWindow(m.created_at, next.created_at)

          return (
            <div key={m.id}>
              {showDivider && <DateDivider iso={m.created_at} />}
              <MessageBubble
                message={m}
                groupedWithPrev={groupedWithPrev}
                groupedWithNext={groupedWithNext}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function withinWindow(aIso: string, bIso: string): boolean {
  return (
    Math.abs(new Date(bIso).getTime() - new Date(aIso).getTime()) <
    GROUP_WINDOW_MS
  )
}

function DateDivider({ iso }: { iso: string }) {
  return (
    <div className="my-4 flex justify-center">
      <span className="bg-chat-incoming-bg text-chat-meta rounded-full px-3 py-1 text-[11px] font-medium shadow-sm">
        {formatDivider(iso)}
      </span>
    </div>
  )
}

function formatDivider(iso: string): string {
  const d = new Date(iso)
  if (isToday(d)) return 'Today'
  if (isYesterday(d)) return 'Yesterday'
  const daysAgo = differenceInCalendarDays(new Date(), d)
  if (daysAgo < 7) return format(d, 'EEEE')
  return format(d, 'MMMM d, yyyy')
}
