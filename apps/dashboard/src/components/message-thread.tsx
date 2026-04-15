import type { DashboardMessage } from '@/lib/types'
import { MessageBubble } from '@/components/message-bubble'

// Vertical stack of message bubbles for one conversation. The API
// returns messages in ascending seq order (oldest first, newest
// last), so we render them straight through and let the flex column
// grow downward. We scroll the container, not the page, so the
// sidebar and chat header stay fixed.
//
// The chat viewer is read-only (§3.1.2): no composer, no send
// button, no typing indicators. This component is deliberately just
// a list — there's no input anywhere on the route, by design.

export function MessageThread({
  messages,
}: {
  messages: DashboardMessage[]
}) {
  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-10">
        <p className="text-chat-meta text-sm">
          No messages in this conversation yet.
        </p>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-1.5 px-6 py-6">
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
      </div>
    </div>
  )
}
