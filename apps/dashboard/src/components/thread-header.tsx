import { Users } from 'lucide-react'

import type { ConversationSummary } from '@/lib/types'
import { avatarColorFor } from '@/lib/avatar-color'

// Peer-identity header at the top of the right column (the thread).
// Mirrors WhatsApp Desktop: avatar, counterparty name, and a soft
// subline (@handle for direct / member count for group). Read-only
// by construction — no call icons, no more-menu, no composer. Those
// affordances are architecturally absent because the dashboard is a
// lurker (§3.1.2): the owner never writes, so there is no mute,
// search-within-thread, or call entry point.

export function ThreadHeader({
  conversation,
}: {
  conversation: ConversationSummary
}) {
  const { title, subtitle, isGroup } = describe(conversation)
  // Same hashing rule as the conversation list row so a contact
  // keeps its color when you open the thread.
  const colorKey =
    conversation.type === 'direct'
      ? conversation.participants[0]?.handle ?? conversation.id
      : conversation.id
  const color = avatarColorFor(colorKey)

  return (
    <header className="bg-background flex h-16 shrink-0 items-center gap-3 border-b px-5">
      <div
        className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-full"
        style={{ color: color.fg }}
      >
        {isGroup ? (
          <Users className="size-5" />
        ) : (
          <span className="text-[15px] font-semibold">
            {title.charAt(0).toUpperCase()}
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[15px] font-semibold tracking-tight">
          {title}
        </span>
        {subtitle && (
          <span className="text-muted-foreground truncate text-[12px] leading-tight">
            {subtitle}
          </span>
        )}
      </div>
    </header>
  )
}

function describe(c: ConversationSummary): {
  title: string
  subtitle: string | null
  isGroup: boolean
} {
  if (c.type === 'group') {
    const count = c.group_member_count ?? 0
    return {
      title: c.group_name ?? 'Unnamed group',
      subtitle: count === 1 ? '1 member' : `${count} members`,
      isGroup: true,
    }
  }
  const other = c.participants[0]
  if (!other) {
    return { title: 'Conversation', subtitle: null, isGroup: false }
  }
  const title = other.display_name ?? `@${other.handle}`
  const subtitle = other.display_name ? `@${other.handle}` : null
  return { title, subtitle, isGroup: false }
}
