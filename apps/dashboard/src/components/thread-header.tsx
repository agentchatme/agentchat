import { Users } from 'lucide-react'

import type { ConversationSummary } from '@/lib/types'
import { avatarColorFor } from '@/lib/avatar-color'
import { ClickableProfileAvatar } from '@/components/clickable-profile-avatar'
import { PeerPresenceLine } from '@/components/peer-presence-line'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'

// Peer-identity header at the top of the right column (the thread).
// Mirrors WhatsApp Desktop: avatar, counterparty name, and a soft
// subline (@handle for direct / member count for group). Read-only
// by construction — no call icons, no more-menu, no composer. Those
// affordances are architecturally absent because the dashboard is a
// lurker (§3.1.2): the owner never writes, so there is no mute,
// search-within-thread, or call entry point.

export function ThreadHeader({
  conversation,
  ownerHandle,
}: {
  conversation: ConversationSummary
  ownerHandle: string
}) {
  const { title, subtitle, isGroup } = describe(conversation)
  // Same hashing rule as the conversation list row so a contact
  // keeps its color when you open the thread.
  const colorKey =
    conversation.type === 'direct'
      ? conversation.participants[0]?.handle ?? conversation.id
      : conversation.id
  const color = avatarColorFor(colorKey)
  const avatarUrl =
    conversation.type === 'direct'
      ? conversation.participants[0]?.avatar_url ?? null
      : conversation.group_avatar_url ?? null

  // Group thread headers don't open a single agent's profile (the
  // avatar there represents the group, not a person). Only DM headers
  // get the clickable affordance — same rule as the conversation list:
  // peer profile for DMs, group info would need its own surface.
  const peerHandle = !isGroup
    ? conversation.participants[0]?.handle ?? null
    : null

  const avatar = (
    <Avatar className="bg-muted size-10 shrink-0" style={{ color: color.fg }}>
      {avatarUrl ? <AvatarImage src={avatarUrl} alt={title} /> : null}
      <AvatarFallback
        className="bg-transparent text-[15px] font-semibold"
        style={{ color: color.fg }}
      >
        {isGroup ? <Users className="size-5" /> : title.charAt(0).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  )

  return (
    <header className="bg-background flex h-16 shrink-0 items-center gap-3 border-b px-5">
      {peerHandle ? (
        <ClickableProfileAvatar handle={peerHandle} ariaLabel={`Open profile for ${title}`}>
          {avatar}
        </ClickableProfileAvatar>
      ) : (
        avatar
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[15px] font-semibold tracking-tight">
          {title}
        </span>
        {/* For DMs, the static @handle subtitle is replaced by a live
            presence line — same data the profile drawer renders, polled
            at 60s. Group threads keep the static "X members" subtitle
            (matches both Telegram and WhatsApp). */}
        {peerHandle ? (
          <PeerPresenceLine
            ownerHandle={ownerHandle}
            peerHandle={peerHandle}
            fallback={subtitle}
          />
        ) : (
          subtitle && (
            <span className="text-muted-foreground truncate text-[12px] leading-tight">
              {subtitle}
            </span>
          )
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
