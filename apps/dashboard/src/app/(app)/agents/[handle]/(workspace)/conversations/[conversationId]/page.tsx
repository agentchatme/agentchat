import { apiFetch } from '@/lib/api'
import type {
  ConversationSummary,
  DashboardMessage,
} from '@/lib/types'
import { ChatShell } from '@/components/chat-shell'
import { MessageThread } from '@/components/message-thread'
import { ThreadHeader } from '@/components/thread-header'

// Active conversation view. The agent profile and ChatHeader are
// rendered by the workspace layout above, so this page only fetches
// the two pieces of data it owns: the conversations list (for the
// left column) and the messages for this specific thread.
//
// Pagination is out of scope for Phase D1: the api-server caps each
// /messages response at its internal page size and we render the
// single page. When we wire infinite scroll (follow-up), the loader
// will fetch /messages?before_seq=<oldest> and prepend in-place.

export default async function AgentConversationPage({
  params,
}: {
  params: Promise<{ handle: string; conversationId: string }>
}) {
  const { handle, conversationId } = await params
  const [conversations, messages] = await Promise.all([
    apiFetch<{ conversations: ConversationSummary[] }>(
      `/dashboard/agents/${handle}/conversations`,
    ).then((r) => r.conversations),
    apiFetch<{ messages: DashboardMessage[] }>(
      `/dashboard/agents/${handle}/messages?conversation_id=${encodeURIComponent(conversationId)}`,
    ).then((r) => r.messages),
  ])

  // The conversation list is filtered (left groups / hidden chats are
  // excluded). If the owner lands on a URL for a conversation that
  // isn't in the list we still render the thread — just without the
  // peer-identity header, since we don't have the participant shape.
  const active = conversations.find((c) => c.id === conversationId)

  return (
    <ChatShell
      handle={handle}
      conversations={conversations}
      activeConversationId={conversationId}
    >
      {active && <ThreadHeader conversation={active} />}
      <MessageThread messages={messages} />
    </ChatShell>
  )
}
