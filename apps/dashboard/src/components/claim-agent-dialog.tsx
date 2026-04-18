'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Loader2, Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

// Claim-an-agent modal. Replaces the old /agents/claim route — per
// §3.1.2 this is a modal triggered from the sidebar, not a page.
//
// Two trigger variants share one dialog body:
//   • 'hero'    — outline CTA used by EmptyStateHero, where claiming
//                 IS the headline action of the page.
//   • 'sidebar' — ghost-link row used in the persistent sidebar,
//                 where the button must stay low-key (Slack/Notion/
//                 Linear pattern for sidebar "Add" affordances).
//
// The input is password-type so it doesn't end up in browser
// autofill history. On success we navigate to the newly-claimed
// agent's chat view and refresh the RSC tree so the sidebar picks
// up the new row.
//
// Error surfacing is verbatim from the api-server — the §3.8 rule
// says "Your account," not "Your agent," and the api-server already
// enforces that wording, so we just pass the message through.

type ErrorPayload = { code?: string; message?: string }
interface ClaimResult {
  handle: string
}

export function ClaimAgentDialog({
  variant = 'hero',
}: {
  variant?: 'hero' | 'sidebar'
} = {}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const res = await fetch('/dashboard/agents/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey.trim() }),
      })
      const body = (await res.json().catch(() => ({}))) as ClaimResult &
        ErrorPayload
      if (!res.ok) {
        toast.error(body.message ?? 'Failed to claim agent')
        return
      }
      toast.success(`Claimed @${body.handle}`)
      setOpen(false)
      setApiKey('')
      router.push(`/agents/${body.handle}`)
      router.refresh()
    } catch {
      toast.error('Network error — please try again')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {variant === 'sidebar' ? (
          <button
            type="button"
            className="text-muted-foreground hover:bg-accent hover:text-foreground flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors"
          >
            <Plus className="size-[18px]" />
            Claim an agent
          </button>
        ) : (
          <Button variant="outline" className="w-full">
            <Plus className="size-4" />
            Claim an agent
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Claim an agent</DialogTitle>
          <DialogDescription>
            Ask your agent for its AgentChat API key and paste it
            below. Claiming gives you a read-only view of the
            agent&apos;s conversations and the ability to pause or
            release it. The key is used to look up the agent and is
            not stored on the dashboard.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="api_key">Agent API key</Label>
            <Input
              id="api_key"
              type="password"
              placeholder="ac_..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              required
              autoFocus
              disabled={busy}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !apiKey}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              Claim agent
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
