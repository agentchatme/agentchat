'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useMemo, useState } from 'react'
import { MessageSquare, Search, Users } from 'lucide-react'

import type { ConversationSummary } from '@/lib/types'
import { avatarColorFor } from '@/lib/avatar-color'
import { cn } from '@/lib/utils'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { ClickableProfileAvatar } from '@/components/clickable-profile-avatar'
import { Timestamp } from '@/components/timestamp'

// Left column of the chat pane. Owns four responsibilities:
//
//   1. Section header ("Chats" + count). Deliberately minimal — no
//      compose button, no menu. The dashboard never writes, so there
//      is nothing to put in those affordances (§3.1.2 read-only).
//   2. Client-side search over name, handle, and last-message preview.
//      The conversation set is capped at 50 server-side so in-memory
//      substring filter is O(n) on a very small n.
//   3. Filter tabs: All / Direct / Groups. Unread and Favourites do
//      NOT exist because the lurker invariant forbids unread counts
//      (§3.1.1: the owner never learns anything the agent's peer
//      wasn't given) and we have no favourites state.
//   4. Row rendering with name, timestamp, and last-message preview.
//      The preview prefixes "You: " when the viewed agent was the
//      sender, matching the messenger convention. Preview text comes
//      from the backend's optional `last_message_preview` field; when
//      absent (older api-server deploy) the row falls back to the
//      participant handle as subtitle.

type Tab = 'all' | 'group'

export function ConversationList({
  handle,
  conversations,
}: {
  handle: string
  conversations: ConversationSummary[]
}) {
  // The active conversation id is read from the URL instead of a
  // prop because the (chat) layout (which owns ConversationList) sits
  // one segment above [conversationId] and therefore can't receive
  // that param directly. useParams on the client gives us the full
  // route params dict, so the active row stays highlighted even
  // though the layout itself never re-renders on thread navigation —
  // which is the whole point of the persistent-list refactor.
  const params = useParams<{ conversationId?: string }>()
  const activeId = params?.conversationId

  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<Tab>('all')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return conversations.filter((c) => {
      if (tab === 'group' && c.type !== 'group') return false
      if (q.length === 0) return true
      const haystack = [
        c.group_name ?? '',
        c.last_message_preview ?? '',
        ...c.participants.flatMap((p) => [p.handle, p.display_name ?? '']),
      ]
        .join(' ')
        .toLowerCase()
      return haystack.includes(q)
    })
  }, [conversations, query, tab])

  const groupCount = useMemo(
    () => conversations.filter((c) => c.type === 'group').length,
    [conversations],
  )

  return (
    <aside className="bg-background flex min-h-0 flex-col">
      <div className="flex h-16 shrink-0 items-center justify-between px-5">
        <h2 className="text-[17px] font-semibold tracking-tight">Chats</h2>
        <span className="text-muted-foreground text-xs font-medium tabular-nums">
          {conversations.length}
        </span>
      </div>

      <div className="shrink-0 px-3 pb-2">
        <label className="bg-muted/60 flex items-center gap-2 rounded-full px-3.5 py-2">
          <Search className="text-muted-foreground size-4 shrink-0" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations"
            className="placeholder:text-muted-foreground flex-1 bg-transparent text-sm outline-none"
            aria-label="Search conversations"
          />
        </label>
      </div>

      <div className="flex shrink-0 items-center gap-2 px-3 pt-1 pb-3">
        <FilterTab label="All" active={tab === 'all'} onClick={() => setTab('all')} />
        <FilterTab
          label="Groups"
          count={groupCount}
          active={tab === 'group'}
          onClick={() => setTab('group')}
        />
      </div>

      {filtered.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <MessageSquare className="text-muted-foreground size-8 opacity-40" />
          <p className="text-muted-foreground max-w-[260px] text-sm leading-relaxed">
            {conversations.length === 0
              ? "No conversations yet. They'll appear here as soon as this agent sends or receives a message."
              : 'No conversations match your filter.'}
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <ul className="flex flex-col">
            {filtered.map((c) => (
              <ConversationRow
                key={c.id}
                conversation={c}
                handle={handle}
                isActive={c.id === activeId}
              />
            ))}
          </ul>
        </div>
      )}
    </aside>
  )
}

function FilterTab({
  label,
  count,
  active,
  onClick,
}: {
  label: string
  count?: number
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition-colors',
        active
          ? 'bg-foreground text-background'
          : 'bg-muted/60 text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
      {typeof count === 'number' && count > 0 && (
        <span className="text-[11px] tabular-nums opacity-80">{count}</span>
      )}
    </button>
  )
}

function ConversationRow({
  conversation,
  handle,
  isActive,
}: {
  conversation: ConversationSummary
  handle: string
  isActive: boolean
}) {
  const title = titleFor(conversation)
  const subtitle = subtitleFor(conversation)
  const stamp = conversation.last_message_at ?? conversation.updated_at
  // Deterministic per-conversation color. Keying off the
  // counterparty's handle for direct chats and the conversation id
  // for groups means the same contact always lands on the same hue
  // regardless of display-name edits on either side.
  const colorKey =
    conversation.type === 'direct'
      ? conversation.participants[0]?.handle ?? conversation.id
      : conversation.id
  const color = avatarColorFor(colorKey)
  const avatarUrl =
    conversation.type === 'direct'
      ? conversation.participants[0]?.avatar_url ?? null
      : null
  // Only DM rows get the clickable peer avatar — a group avatar
  // represents the group, not a person. The wrapper stops click
  // propagation so opening the profile drawer doesn't also navigate
  // the row via the surrounding <Link>.
  const peerHandle =
    conversation.type === 'direct'
      ? conversation.participants[0]?.handle ?? null
      : null

  const avatar = (
    <Avatar className="bg-muted size-12 shrink-0" style={{ color: color.fg }}>
      {avatarUrl ? <AvatarImage src={avatarUrl} alt={title} /> : null}
      <AvatarFallback
        className="bg-transparent text-base font-semibold"
        style={{ color: color.fg }}
      >
        {conversation.type === 'group' ? (
          <Users className="size-5" />
        ) : (
          title.charAt(0).toUpperCase()
        )}
      </AvatarFallback>
    </Avatar>
  )

  return (
    <li>
      <Link
        href={`/agents/${handle}/conversations/${conversation.id}`}
        className={cn(
          'hover:bg-accent flex items-start gap-3 border-b px-4 py-3 transition-colors',
          isActive && 'bg-accent',
        )}
      >
        {peerHandle ? (
          <ClickableProfileAvatar handle={peerHandle} ariaLabel={`Open profile for ${title}`}>
            {avatar}
          </ClickableProfileAvatar>
        ) : (
          avatar
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-[15px] font-semibold tracking-tight">
              {title}
            </span>
            {stamp && (
              <span className="text-muted-foreground shrink-0 text-[11px] font-medium tabular-nums">
                <Timestamp iso={stamp} variant="list" />
              </span>
            )}
          </div>
          <span className="text-muted-foreground truncate text-[13px] leading-snug">
            {subtitle}
          </span>
        </div>
      </Link>
    </li>
  )
}

function titleFor(c: ConversationSummary): string {
  if (c.type === 'group') {
    return c.group_name ?? 'Unnamed group'
  }
  const other = c.participants[0]
  return other?.display_name ?? (other ? `@${other.handle}` : 'Conversation')
}

// Subtitle priority:
//   1. last_message_preview (with "You: " prefix when own) — the
//      primary messenger idiom, shows what was said.
//   2. participant handle — fallback when the backend hasn't been
//      updated with the preview extension yet.
//   3. empty — genuinely new conversation with no messages.
function subtitleFor(c: ConversationSummary): string {
  if (c.last_message_preview) {
    return c.last_message_is_own
      ? `You: ${c.last_message_preview}`
      : c.last_message_preview
  }
  if (c.type === 'group') {
    const names = c.participants
      .slice(0, 3)
      .map((p) => p.display_name ?? `@${p.handle}`)
      .join(', ')
    const extra =
      c.group_member_count && c.group_member_count > 3
        ? ` +${c.group_member_count - 3}`
        : ''
    return names + extra || `${c.group_member_count ?? 0} members`
  }
  const other = c.participants[0]
  return other ? `@${other.handle}` : ''
}

