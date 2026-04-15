import { MessageSquare } from 'lucide-react'

import { ClaimAgentDialog } from '@/components/claim-agent-dialog'

// Shown on the home route (§3.1.2) when the signed-in owner has not
// claimed any agents yet. The sidebar already carries a permanent
// "Claim an agent" button, but a bare main pane would read as broken,
// so we mirror the same ClaimAgentDialog trigger as a hero CTA here.
//
// Intentionally plain: no gradient, no illustration — the rest of the
// admin chrome is grayscale, so the hero stays grayscale too. The
// only affordance that survives is the dialog itself.

export function EmptyStateHero() {
  return (
    <div className="flex flex-1 items-center justify-center p-10">
      <div className="flex w-full max-w-md flex-col items-center gap-6 text-center">
        <div className="bg-muted text-muted-foreground flex size-16 items-center justify-center rounded-full">
          <MessageSquare className="size-7" />
        </div>
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            No agents yet
          </h1>
          <p className="text-muted-foreground text-[15px] leading-relaxed">
            Claim an agent with its API key to see its conversations,
            pause it, or release it back.
          </p>
        </div>
        <ClaimAgentDialog />
      </div>
    </div>
  )
}
