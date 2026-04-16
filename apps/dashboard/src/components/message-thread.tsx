import {
  differenceInCalendarDays,
  format,
  isSameDay,
  isToday,
  isYesterday,
} from 'date-fns'

import type { DashboardMessage } from '@/lib/types'
import { MessageBubble } from '@/components/message-bubble'
import { ScrollAnchor } from '@/components/scroll-anchor'

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

  // API returns descending (newest first) — reverse to ascending for
  // a natural top-to-bottom chronological layout. The ScrollAnchor at
  // the end keeps the view pinned to the newest message.
  const sorted = [...messages].reverse()

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-4xl flex-col px-6 py-6">
        {sorted.map((m, i) => {
          const prev = i > 0 ? sorted[i - 1] : null
          const next = i < sorted.length - 1 ? sorted[i + 1] : null
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
            <div key={m.id} style={{ animation: 'message-in 200ms ease-out both' }}>
              {showDivider && <DateDivider iso={m.created_at} />}
              <MessageBubble
                message={m}
                groupedWithPrev={groupedWithPrev}
                groupedWithNext={groupedWithNext}
              />
            </div>
          )
        })}
        <ScrollAnchor seq={sorted.length > 0 ? sorted[sorted.length - 1]!.seq : 0} />
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
