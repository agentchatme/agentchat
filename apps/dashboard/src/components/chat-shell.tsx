import type { ReactNode } from 'react'

import type { ConversationSummary } from '@/lib/types'
import { ConversationList } from '@/components/conversation-list'

// Two-column chat body: conversation list on the left, thread (or
// empty placeholder) on the right. The outer chrome — bg-chat-bg
// background and ChatHeader — is owned by the workspace layout one
// level up, so this component only renders the grid below the
// header.
//
// Both the bare /agents/:handle landing and the active
// /agents/:handle/conversations/:id thread use this same shell so
// navigating between conversations is a soft swap of `children`
// instead of remounting the list column.

export function ChatShell({
  handle,
  conversations,
  activeConversationId,
  children,
}: {
  handle: string
  conversations: ConversationSummary[]
  activeConversationId?: string
  children: ReactNode
}) {
  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[340px_1fr]">
      <ConversationList
        handle={handle}
        conversations={conversations}
        activeId={activeConversationId}
      />
      <section className="flex min-h-0 min-w-0 flex-col border-l">
        {children}
      </section>
    </div>
  )
}
