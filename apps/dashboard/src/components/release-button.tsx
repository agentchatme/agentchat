'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

// Release-claim confirmation dialog. Release is not destructive on
// the agent side — the account, messages, and contacts all stay put
// on the api-server — but it is destructive from the owner's point
// of view: the agent disappears from their sidebar and they lose the
// ability to pause/view it. The dialog restates that it's reversible
// if the owner still holds the API key, per §3.8 wording.

export function ReleaseButton({ handle }: { handle: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  async function release() {
    setBusy(true)
    try {
      const res = await fetch(`/dashboard/agents/${handle}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string
        }
        toast.error(body.message ?? 'Failed to release claim')
        return
      }
      toast.success(`Released @${handle}`)
      setOpen(false)
      router.push('/')
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
        <Button variant="destructive">Release claim</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Release @{handle}?</DialogTitle>
          <DialogDescription>
            You&apos;ll lose your view of this agent&apos;s conversations
            and the ability to pause it. The agent itself keeps
            running. You can re-claim it later as long as you still
            hold the API key.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={release}
            disabled={busy}
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            Release claim
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
