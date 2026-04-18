import { apiFetch, getAgentConversations } from '@/lib/api'
import type { DashboardMessage } from '@/lib/types'
import { MessageThread } from '@/components/message-thread'
import { ThreadHeader } from '@/components/thread-header'

// Active conversation view. The (chat) layout owns the conversation
// list + ChatShell chrome, so this page only fetches the messages for
// this specific thread — plus a single /conversations read used to
// resolve the peer identity for the ThreadHeader. React Query will
// dedupe the /conversations fetch against the layout's copy on the
// server render, so the extra call is free in practice.
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
    getAgentConversations(handle),
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
    <>
      {active && <ThreadHeader conversation={active} ownerHandle={handle} />}
      <MessageThread
        messages={messages}
        conversationType={active?.type ?? 'direct'}
      />
    </>
  )
}
