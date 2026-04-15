import { Skeleton } from '@/components/ui/skeleton'

// Fallback for the (chat) segment — fires while the (chat) layout
// resolves its /conversations fetch on a cold enter into the chat
// area (e.g. switching agents, or clicking Chat from Contacts when
// the list isn't cached yet). Mirrors ChatShell's two-column body:
// the left column is a list-row skeleton, the right column is an
// empty thread placeholder. This is the ONLY skeleton that draws a
// full list + thread shape — the inner conversation-page loading
// draws the thread-only skeleton because the (chat) layout is
// already mounted by then.

export default function ChatLoading() {
  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[340px_1fr]">
      <aside className="bg-background flex min-h-0 flex-col p-3">
        <div className="flex flex-col gap-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      </aside>
      <section className="flex min-h-0 min-w-0 flex-col border-l" />
    </div>
  )
}
