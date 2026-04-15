import { Skeleton } from '@/components/ui/skeleton'

// Body-only skeleton for the block-list view. Same pattern as the
// contacts loading — keeps the ChatHeader pinned, fills the body.

export default function BlocksLoading() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-6">
      <Skeleton className="h-6 w-28" />
      <div className="mt-2 flex flex-col gap-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    </div>
  )
}
