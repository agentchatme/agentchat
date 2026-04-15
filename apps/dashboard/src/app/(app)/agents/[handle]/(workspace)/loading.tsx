import { Skeleton } from '@/components/ui/skeleton'

// Fallback for the (workspace) segment — fires while the workspace
// layout's /dashboard/agents/:handle fetch resolves on a fresh agent
// switch. The (app) sidebar stays visible via the parent layout, so
// this skeleton only fills the main column.
//
// Scope is deliberately narrow: ONLY the ChatHeader chrome. The
// workspace layout does not know whether the leaf under it is chat,
// contacts, or blocks — drawing a fake chat body here would flash a
// conversation-list skeleton on every navigation into contacts or
// blocks, which is exactly the wrong visual. Each leaf owns its own
// inner loading.tsx for the body-specific skeleton:
//   * (chat)/loading.tsx — list + thread placeholder
//   * (chat)/conversations/[id]/loading.tsx — thread-only
//   * contacts/loading.tsx & blocks/loading.tsx — their own
//
// Keeping this outer skeleton header-only also means that navigating
// between chat and contacts does NOT blink the body region at all
// when the workspace layout is already mounted (handle unchanged):
// the workspace layout is cached by the Next router and only the
// inner segment's loading.tsx fires.

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
      <div className="flex min-h-0 flex-1" />
    </div>
  )
}
