import { getAgentConversations } from '@/lib/api'
import { ChatShell } from '@/components/chat-shell'

// Persistent chrome for the chat view. Fetches the conversation list
// once when the owner enters the chat area and keeps it mounted as
// they click between individual threads — Next's partial rendering
// swaps only the `{children}` slot on navigation, so the left column
// (ConversationList + its search query + its scroll position) stays
// put and there is no list-column blink between threads.
//
// This layout sits INSIDE the path-invisible `(chat)` route group so
// it scopes only the empty-state root and the active-thread page.
// Sibling routes that are NOT chat — /contacts, /blocks — live in the
// outer (workspace) layout and render full-width without ChatShell.
//
// The `(chat)` group also lets us skip re-fetching /conversations on
// every thread click: the layout only re-renders when the handle
// param changes (agent switch), not when conversationId changes.

export default async function ChatLayout({
  params,
  children,
}: {
  params: Promise<{ handle: string }>
  children: React.ReactNode
}) {
  const { handle } = await params
  const conversations = await getAgentConversations(handle)

  return (
    <ChatShell handle={handle} conversations={conversations}>
      {children}
    </ChatShell>
  )
}
