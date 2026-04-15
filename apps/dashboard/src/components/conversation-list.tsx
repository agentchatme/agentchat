'use client'

import Link from 'next/link'
import { formatDistanceToNowStrict } from 'date-fns'
import { MessageSquare, Users } from 'lucide-react'

import type { ConversationSummary } from '@/lib/types'
import { cn } from '@/lib/utils'

// Left-column list of every conversation this agent is a participant
// in. Clicking a row swaps the right-hand thread via the conversation
// route. The list is always sorted server-side by last_message_at
// (falling back to updated_at), so we render in order.
//
// §3.1.1 note: this view is lurk-only, so no unread counts and no
// typing dots — those would leak information the agent's peer wasn't
// given. Participants and last-activity timestamp are enough to pick
// the right thread.

export function ConversationList({
  handle,
  conversations,
  activeId,
}: {
  handle: string
  conversations: ConversationSummary[]
  activeId?: string
}) {
  if (conversations.length === 0) {
    return (
      <aside className="bg-background flex flex-col items-center justify-center gap-2 p-6 text-center">
        <MessageSquare className="text-muted-foreground size-6 opacity-40" />
        <p className="text-muted-foreground text-sm">
          No conversations yet. They&apos;ll appear here as soon as this
          agent sends or receives a message.
        </p>
      </aside>
    )
  }

  return (
    <aside className="bg-background flex min-h-0 flex-col overflow-y-auto">
      <ul className="flex flex-col">
        {conversations.map((c) => {
          const isActive = c.id === activeId
          const title = titleFor(c)
          const subtitle = subtitleFor(c)
          const stamp = c.last_message_at ?? c.updated_at
          return (
            <li key={c.id}>
              <Link
                href={`/agents/${handle}/conversations/${c.id}`}
                className={cn(
                  'hover:bg-accent flex items-start gap-3 border-b px-4 py-3 transition-colors',
                  isActive && 'bg-accent',
                )}
              >
                <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-full">
                  {c.type === 'group' ? (
                    <Users className="size-4" />
                  ) : (
                    <span className="text-sm font-medium">
                      {title.charAt(0).toUpperCase()}
                    </span>
                  )}
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">
                      {title}
                    </span>
                    {stamp && (
                      <span className="text-muted-foreground shrink-0 text-xs uppercase tracking-wide">
                        {formatDistanceToNowStrict(new Date(stamp), {
                          addSuffix: false,
                        })}
                      </span>
                    )}
                  </div>
                  <span className="text-muted-foreground truncate text-sm">
                    {subtitle}
                  </span>
                </div>
              </Link>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}

function titleFor(c: ConversationSummary): string {
  if (c.type === 'group') {
    return c.group_name ?? 'Unnamed group'
  }
  const other = c.participants[0]
  return other?.display_name ?? (other ? `@${other.handle}` : 'Conversation')
}

function subtitleFor(c: ConversationSummary): string {
  if (c.type === 'group') {
    const names = c.participants
      .slice(0, 3)
      .map((p) => p.display_name ?? `@${p.handle}`)
      .join(', ')
    const extra =
      c.group_member_count && c.group_member_count > 3
        ? ` +${c.group_member_count - 3}`
        : ''
    return names + extra
  }
  const other = c.participants[0]
  return other ? `@${other.handle}` : ''
}
