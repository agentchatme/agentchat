import { isSameDay } from 'date-fns'

import type { DashboardMessage } from '@/lib/types'
import { MessageBubble } from '@/components/message-bubble'
import { ScrollAnchor } from '@/components/scroll-anchor'
import { Timestamp } from '@/components/timestamp'
import { ClickableProfileAvatar } from '@/components/clickable-profile-avatar'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'

const GROUP_WINDOW_MS = 5 * 60 * 1000

export function MessageThread({
  messages,
  conversationType,
}: {
  messages: DashboardMessage[]
  conversationType: 'direct' | 'group'
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

  const isGroup = conversationType === 'group'

  const sorted = [...messages].reverse()

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-4xl flex-col px-6 py-6">
        {sorted.map((m, i) => {
          const prev = i > 0 ? sorted[i - 1] : null
          const next = i < sorted.length - 1 ? sorted[i + 1] : null
          const showDivider =
            !prev || !isSameDay(new Date(prev.created_at), new Date(m.created_at))
          // In groups, cluster only when the same *sender* posts back-to-back.
          // DMs still cluster by is_own alone since there are only two parties.
          const sameSenderAsPrev =
            !!prev &&
            prev.is_own === m.is_own &&
            (!isGroup || prev.sender_handle === m.sender_handle)
          const sameSenderAsNext =
            !!next &&
            next.is_own === m.is_own &&
            (!isGroup || next.sender_handle === m.sender_handle)
          const groupedWithPrev =
            !showDivider && sameSenderAsPrev && withinWindow(prev!.created_at, m.created_at)
          const groupedWithNext =
            !!next &&
            isSameDay(new Date(m.created_at), new Date(next.created_at)) &&
            sameSenderAsNext &&
            withinWindow(m.created_at, next.created_at)

          const showSenderHeader =
            isGroup && !m.is_own && !groupedWithPrev && m.sender_handle !== null

          return (
            <div key={m.id} style={{ animation: 'message-in 200ms ease-out both' }}>
              {showDivider && <DateDivider iso={m.created_at} />}
              {showSenderHeader && <SenderHeader message={m} />}
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

function SenderHeader({ message }: { message: DashboardMessage }) {
  const name = message.sender_display_name ?? message.sender_handle ?? 'Unknown'
  const initial = (name.trim()[0] ?? '?').toUpperCase()
  const handle = message.sender_handle
  const avatar = (
    <Avatar className="h-5 w-5">
      {message.sender_avatar_url ? (
        <AvatarImage src={message.sender_avatar_url} alt={name} />
      ) : null}
      <AvatarFallback className="text-[10px]">{initial}</AvatarFallback>
    </Avatar>
  )
  return (
    <div className="mt-3 mb-1 flex items-center gap-2 pl-1">
      {handle ? (
        <ClickableProfileAvatar handle={handle} ariaLabel={`Open profile for ${name}`}>
          {avatar}
        </ClickableProfileAvatar>
      ) : (
        avatar
      )}
      <span className="text-chat-meta text-[12px] font-medium">{name}</span>
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
      <span className="bg-chat-incoming-bg text-chat-meta rounded-full px-3 py-1 text-[11px] font-medium">
        <Timestamp iso={iso} variant="divider" />
      </span>
    </div>
  )
}
