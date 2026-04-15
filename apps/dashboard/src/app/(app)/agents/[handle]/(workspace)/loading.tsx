import { Skeleton } from '@/components/ui/skeleton'

// Fallback for the (workspace) segment. Shown while the workspace
// layout resolves /dashboard/agents/:handle AND the leaf page
// resolves its own data. The (app) sidebar stays visible via the
// parent layout — only the main column is replaced with this
// skeleton. Matches the ChatHeader + two-column body chrome so the
// switch from skeleton to real content is visually continuous.

export default function WorkspaceLoading() {
  return (
    <div className="bg-chat-bg flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="bg-background flex h-[65px] shrink-0 items-center gap-3.5 border-b px-6">
        <Skeleton className="size-10 rounded-full" />
        <div className="flex flex-1 flex-col gap-1.5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-24" />
        </div>
      </header>
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
    </div>
  )
}
