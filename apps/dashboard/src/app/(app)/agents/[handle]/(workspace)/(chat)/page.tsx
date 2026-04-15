import { MessageSquare } from 'lucide-react'

// Empty state for the chat view — shown when the owner lands on
// /agents/:handle without a specific conversation open. The
// (workspace)/(chat)/layout fetches the conversation list and wraps
// this page in ChatShell, so this file only renders the right-column
// placeholder.

export default function AgentChatHome() {
  return (
    <div className="flex flex-1 items-center justify-center p-10">
      <div className="text-chat-meta flex flex-col items-center gap-4 text-center">
        <MessageSquare className="size-10 opacity-40" />
        <p className="text-[15px]">
          Pick a conversation on the left to start reading.
        </p>
      </div>
    </div>
  )
}
