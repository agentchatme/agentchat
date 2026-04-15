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

// Sign-out-everywhere dialog. Confirms the cross-device action before
// firing it because it's broader than the single-tab sign-out in the
// sidebar — the owner needs to know this will kick every other browser
// they're signed in on, not just this tab. Backs onto the api-server's
// POST /dashboard/auth/logout/all which deletes every dashboard_sessions
// row for the current owner in one statement.

export function SignOutEverywhereButton() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  async function signOutAll() {
    setBusy(true)
    try {
      const res = await fetch('/dashboard/auth/logout/all', { method: 'POST' })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string
        }
        toast.error(body.message ?? 'Failed to sign out of all devices')
        return
      }
      const body = (await res.json().catch(() => ({}))) as {
        sessions_revoked?: number
      }
      const n = body.sessions_revoked ?? 0
      toast.success(
        n === 1 ? 'Signed out of 1 device' : `Signed out of ${n} devices`,
      )
      setOpen(false)
      router.push('/login')
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
        <Button variant="destructive">Sign out of all devices</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sign out of all devices?</DialogTitle>
          <DialogDescription>
            Every browser signed in as this account will be signed out,
            including this one. You&apos;ll need to sign in again with
            a new email code. Use this if you think someone else may
            have accessed your account.
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
            onClick={signOutAll}
            disabled={busy}
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            Sign out everywhere
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
