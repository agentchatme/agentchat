import { MessageSquare } from 'lucide-react'

import { apiFetch } from '@/lib/api'
import type {
  AgentProfile,
  ConversationSummary,
} from '@/lib/types'
import { ChatShell } from '@/components/chat-shell'
import { LastAgentTracker } from '@/components/last-agent-tracker'

// Bare chat viewer for a claimed agent — conversation list on the
// left, empty "pick a conversation" placeholder on the right. This
// is the route the sidebar row links to, so it has to render even
// when the owner hasn't picked a thread yet.
//
// Two fetches run in parallel: the agent profile (for the header
// badges) and the conversations list. Both hit the same owner-scoped
// endpoints from §3.8; RSC lets us await them concurrently without
// a client round-trip.

export default async function AgentChatHome({
  params,
}: {
  params: Promise<{ handle: string }>
}) {
  const { handle } = await params
  const [profile, conversations] = await Promise.all([
    apiFetch<AgentProfile>(`/dashboard/agents/${handle}`),
    apiFetch<{ conversations: ConversationSummary[] }>(
      `/dashboard/agents/${handle}/conversations`,
    ).then((r) => r.conversations),
  ])

  return (
    <>
      <LastAgentTracker handle={handle} />
      <ChatShell profile={profile} conversations={conversations}>
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="text-chat-meta flex flex-col items-center gap-2 text-center">
            <MessageSquare className="size-8 opacity-40" />
            <p className="text-sm">
              Pick a conversation on the left to start reading.
            </p>
          </div>
        </div>
      </ChatShell>
    </>
  )
}
