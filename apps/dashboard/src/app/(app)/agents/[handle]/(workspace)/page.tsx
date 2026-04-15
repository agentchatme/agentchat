import { MessageSquare } from 'lucide-react'

import { apiFetch } from '@/lib/api'
import type { ConversationSummary } from '@/lib/types'
import { ChatShell } from '@/components/chat-shell'

// Bare chat view — conversation list on the left, "pick a
// conversation" placeholder on the right. The agent profile and the
// ChatHeader are rendered by the workspace layout above, so this
// page only fetches the conversations list.

export default async function AgentChatHome({
  params,
}: {
  params: Promise<{ handle: string }>
}) {
  const { handle } = await params
  const conversations = await apiFetch<{
    conversations: ConversationSummary[]
  }>(`/dashboard/agents/${handle}/conversations`).then((r) => r.conversations)

  return (
    <ChatShell handle={handle} conversations={conversations}>
      <div className="flex flex-1 items-center justify-center p-10">
        <div className="text-chat-meta flex flex-col items-center gap-4 text-center">
          <MessageSquare className="size-10 opacity-40" />
          <p className="text-[15px]">
            Pick a conversation on the left to start reading.
          </p>
        </div>
      </div>
    </ChatShell>
  )
}
