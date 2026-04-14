import type { ReactNode } from 'react'

import type {
  AgentProfile,
  ConversationSummary,
} from '@/lib/types'
import { ChatHeader } from '@/components/chat-header'
import { ConversationList } from '@/components/conversation-list'

// Two-column layout inside the main pane for the chat viewer
// (§3.1.2). The header sits on top, the conversation list on the
// left, and the thread (or empty placeholder) on the right.
//
// Both routes — the bare /agents/:handle landing and the active
// /agents/:handle/conversations/:id thread — render the same shell
// so navigating between conversations is a soft swap of `children`
// instead of a full remount of the list column.

export function ChatShell({
  profile,
  conversations,
  activeConversationId,
  children,
}: {
  profile: AgentProfile
  conversations: ConversationSummary[]
  activeConversationId?: string
  children: ReactNode
}) {
  return (
    <div className="bg-chat-bg flex h-dvh min-w-0 flex-1 flex-col">
      <ChatHeader profile={profile} />
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[320px_1fr]">
        <ConversationList
          handle={profile.handle}
          conversations={conversations}
          activeId={activeConversationId}
        />
        <section className="flex min-w-0 flex-col border-l">{children}</section>
      </div>
    </div>
  )
}
