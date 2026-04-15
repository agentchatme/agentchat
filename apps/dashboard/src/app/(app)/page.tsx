import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { MessageSquare } from 'lucide-react'

import { getBootstrap } from '@/lib/api'
import { EmptyStateHero } from '@/components/empty-state-hero'

// Home state (§3.1.2):
//
//   Zero claimed agents      → hero "+ Claim your first agent" CTA in
//                              the main pane (sidebar still shows the
//                              claim button and the nav block)
//   One+ claimed agents      → auto-select the first agent and redirect
//                              to their chat view. The last-viewed agent
//                              is remembered via ac_last_agent and we
//                              prefer it (§3.1.2 — matches the
//                              Telegram/Slack/Linear default).
//
// getBootstrap() is React.cache()-memoized so calling it here reuses
// the same promise the (app) layout already awaited — no duplicate
// /dashboard/bootstrap round trip, no duplicate Fly hop. The layout
// also already redirected if it was null, so the non-null assertion
// below is safe in practice — we keep the explicit guard only as a
// fail-closed belt-and-braces for any future refactor that changes
// the layout's auth semantics.

export default async function AppHome() {
  const bootstrap = await getBootstrap()
  if (!bootstrap) {
    redirect('/login')
  }

  const { agents } = bootstrap

  if (agents.length === 0) {
    return <EmptyStateHero />
  }

  const cookieStore = await cookies()
  const lastHandle = cookieStore.get('ac_last_agent')?.value
  const pick =
    agents.find((a) => a.handle === lastHandle)?.handle ??
    agents[0]?.handle

  if (pick) {
    redirect(`/agents/${pick}`)
  }

  return (
    <div className="flex flex-1 items-center justify-center p-10">
      <div className="text-muted-foreground flex flex-col items-center gap-4 text-center">
        <MessageSquare className="size-10 opacity-40" />
        <p className="text-[15px]">
          Pick an agent from the sidebar to begin.
        </p>
      </div>
    </div>
  )
}
