'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'
import { Loader2, Pause, PauseOctagon, Play } from 'lucide-react'

import type { PauseMode } from '@/lib/types'
import { cn } from '@/lib/utils'

// Three-state pause control from §3.1.1:
//
//   none → send-paused → fully-paused → back to none
//
// Each row is its own button so the effect is obvious from the
// label — we intentionally avoid a radio group or segmented switch
// because the consequences of "Send paused" vs "Fully paused" are
// different enough that owners should read the consequence copy
// before clicking. The api-server enforces the same wording in
// error messages; this UI matches it so nothing reads inconsistent.
//
// router.refresh() after every mutation rewalks the RSC tree, which
// re-renders the sidebar StatusDot, the chat header badges, and this
// component's own currentMode. No client-side cache to invalidate.

export function PauseControls({
  handle,
  currentMode,
}: {
  handle: string
  currentMode: PauseMode
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<PauseMode | null>(null)

  async function apply(mode: PauseMode) {
    setBusy(mode)
    try {
      const res =
        mode === 'none'
          ? await fetch(`/dashboard/agents/${handle}/unpause`, {
              method: 'POST',
            })
          : await fetch(`/dashboard/agents/${handle}/pause`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ mode }),
            })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string
        }
        toast.error(body.message ?? 'Failed to update pause state')
        return
      }
      toast.success(
        mode === 'none'
          ? 'Agent resumed'
          : mode === 'send'
            ? 'Send paused'
            : 'Fully paused',
      )
      router.refresh()
    } catch {
      toast.error('Network error — please try again')
    } finally {
      setBusy(null)
    }
  }

  const options: Array<{
    mode: PauseMode
    label: string
    description: string
    icon: typeof Play
  }> = [
    {
      mode: 'none',
      label: 'Active',
      description: 'The agent can send and receive messages normally.',
      icon: Play,
    },
    {
      mode: 'send',
      label: 'Send paused',
      description:
        'The agent can still receive messages, but any send attempt is rejected with a paused error. Owner-facing only.',
      icon: Pause,
    },
    {
      mode: 'full',
      label: 'Fully paused',
      description:
        'The agent cannot send or receive. Incoming messages are rejected at delivery time.',
      icon: PauseOctagon,
    },
  ]

  return (
    <div className="flex flex-col gap-2.5">
      {options.map(({ mode, label, description, icon: Icon }) => {
        const isCurrent = currentMode === mode
        const isLoading = busy === mode
        return (
          <button
            key={mode}
            type="button"
            disabled={isCurrent || busy !== null}
            onClick={() => apply(mode)}
            className={cn(
              'hover:bg-accent flex items-start gap-3.5 rounded-lg border p-4 text-left transition-colors disabled:cursor-not-allowed',
              isCurrent && 'border-primary bg-accent',
            )}
          >
            <div className="bg-muted text-muted-foreground mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-md">
              {isLoading ? (
                <Loader2 className="size-5 animate-spin" />
              ) : (
                <Icon className="size-5" />
              )}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="text-[15px] font-semibold">{label}</span>
                {isCurrent && (
                  <span className="bg-primary/10 text-primary rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider">
                    Current
                  </span>
                )}
              </div>
              <span className="text-muted-foreground text-sm leading-relaxed">
                {description}
              </span>
            </div>
          </button>
        )
      })}
    </div>
  )
}
