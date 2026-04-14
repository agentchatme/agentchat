import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { MessageSquare } from 'lucide-react'

import { apiFetch } from '@/lib/api'
import type { ClaimedAgent } from '@/lib/types'
import { EmptyStateHero } from '@/components/empty-state-hero'

// Home state (§3.1.2):
//
//   Zero claimed agents      → hero "+ Claim your first agent" CTA in
//                              the main pane (sidebar still shows the
//                              claim button and the nav block)
//   One+ claimed agents      → auto-select the first agent and redirect
//                              to their chat view. Follow-up: remember
//                              the last viewed agent in a cookie and
//                              prefer that one (§3.1.2 — matches the
//                              Telegram/Slack/Linear default).
//
// Refetching the agents list here is cheap but technically a
// duplicate of the fetch in (app)/layout.tsx — Next memoizes fetch
// within a single RSC render, and apiFetch forwards cookies on every
// call, so a duplicate is safe but wastes a hop. Worth moving to a
// server-side cache later; not worth pre-optimizing now.

export default async function AppHome() {
  const { agents } = await apiFetch<{ agents: ClaimedAgent[] }>(
    '/dashboard/agents',
  )

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
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="text-muted-foreground flex flex-col items-center gap-3 text-center">
        <MessageSquare className="size-8 opacity-40" />
        <p className="text-sm">Pick an agent from the sidebar to begin.</p>
      </div>
    </div>
  )
}
