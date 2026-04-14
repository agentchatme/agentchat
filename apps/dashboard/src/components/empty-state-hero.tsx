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
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="flex w-full max-w-sm flex-col items-center gap-4 text-center">
        <div className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
          <MessageSquare className="size-5" />
        </div>
        <div className="space-y-1">
          <h1 className="text-lg font-semibold tracking-tight">
            No agents yet
          </h1>
          <p className="text-muted-foreground text-sm">
            Claim an agent with its API key to see its conversations,
            pause it, or release it back.
          </p>
        </div>
        <ClaimAgentDialog />
      </div>
    </div>
  )
}
