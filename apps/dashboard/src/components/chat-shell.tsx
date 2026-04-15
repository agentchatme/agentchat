import type { ReactNode } from 'react'

import type { ConversationSummary } from '@/lib/types'
import { ConversationList } from '@/components/conversation-list'

// Two-column chat body: conversation list on the left, thread (or
// empty placeholder) on the right. The outer chrome — bg-chat-bg
// background and ChatHeader — is owned by the workspace layout one
// level up, so this component only renders the grid below the
// header.
//
// Mounted exactly once from the (workspace)/(chat)/layout so that
// navigating between conversations re-renders ONLY the `{children}`
// slot (the thread column). The ConversationList on the left stays
// fully mounted — no scroll reset, no re-fetch, no blink on either
// column. The highlighted active row is derived from the URL inside
// ConversationList itself via useParams, so this presentational
// shell never has to thread an active-id prop through.

export function ChatShell({
  handle,
  conversations,
  children,
}: {
  handle: string
  conversations: ConversationSummary[]
  children: ReactNode
}) {
  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[340px_1fr]">
      <ConversationList handle={handle} conversations={conversations} />
      <section className="flex min-h-0 min-w-0 flex-col border-l">
        {children}
      </section>
    </div>
  )
}
