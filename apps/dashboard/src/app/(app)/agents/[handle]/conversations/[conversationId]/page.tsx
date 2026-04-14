import { apiFetch } from '@/lib/api'
import type {
  AgentProfile,
  ConversationSummary,
  DashboardMessage,
} from '@/lib/types'
import { ChatShell } from '@/components/chat-shell'
import { MessageThread } from '@/components/message-thread'
import { LastAgentTracker } from '@/components/last-agent-tracker'

// Active conversation view. Reuses ChatShell so the left column
// stays in place when the owner clicks between threads — Next's
// partial-rendering treats this as a swap of the `children` prop.
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
  const [profile, conversations, messages] = await Promise.all([
    apiFetch<AgentProfile>(`/dashboard/agents/${handle}`),
    apiFetch<{ conversations: ConversationSummary[] }>(
      `/dashboard/agents/${handle}/conversations`,
    ).then((r) => r.conversations),
    apiFetch<{ messages: DashboardMessage[] }>(
      `/dashboard/agents/${handle}/messages?conversation_id=${encodeURIComponent(conversationId)}`,
    ).then((r) => r.messages),
  ])

  return (
    <>
      <LastAgentTracker handle={handle} />
      <ChatShell
        profile={profile}
        conversations={conversations}
        activeConversationId={conversationId}
      >
        <MessageThread messages={messages} />
      </ChatShell>
    </>
  )
}
