import { Skeleton } from '@/components/ui/skeleton'

// Shown while the active-thread page resolves its /messages fetch.
// The (chat) layout above owns the persistent ChatShell, so the
// ConversationList on the left stays mounted and this fallback
// only needs to fill the thread column (ChatShell's `children`
// slot). That is why there is no list-column skeleton here —
// rendering one would create a second list that flashes next to
// the real one during thread navigation.

export default function ConversationLoading() {
  return (
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
  )
}
