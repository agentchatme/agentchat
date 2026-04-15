import { Skeleton } from '@/components/ui/skeleton'

// Shown while the conversation page resolves its /conversations and
// /messages fetches. The (workspace) layout is already mounted so
// ChatHeader and the bg-chat-bg wrapper stay visible — this fallback
// only replaces the body two-column area, which keeps the agent
// identity header pinned while the new thread loads.

export default function ConversationLoading() {
  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="w-[340px] shrink-0 border-r p-3">
        <div className="flex flex-col gap-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col justify-end gap-3 p-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className={i % 2 === 0 ? 'flex' : 'flex justify-end'}
          >
            <Skeleton className="h-10 w-2/3 max-w-md" />
          </div>
        ))}
      </div>
    </div>
  )
}
