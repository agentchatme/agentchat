import { Skeleton } from '@/components/ui/skeleton'

// Fallback shown by the (app) segment's Suspense boundary while the
// layout's getBootstrap() fetch resolves. Renders an approximate
// sidebar silhouette so the user sees the app shell immediately on
// /login → / navigation, never a blank screen, even if the network
// is slow. Pure server component, zero data fetches.

export default function AppLoading() {
  return (
    <div className="bg-background flex h-dvh overflow-hidden">
      <aside className="bg-card hidden w-72 shrink-0 flex-col gap-3 border-r p-5 md:flex lg:w-80">
        <Skeleton className="h-7 w-32" />
        <div className="mt-6 flex flex-col gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
        <div className="mt-auto flex flex-col gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      </aside>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col" />
    </div>
  )
}
