'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import type { PauseMode } from '../lib/types'

// Three-state control: none → send → full → back to none. Each press
// calls the corresponding endpoint and refreshes the RSC tree so the
// status + pause badges update without a hard reload.

export function PauseControls({
  handle,
  currentMode,
}: {
  handle: string
  currentMode: PauseMode
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function pause(mode: 'send' | 'full') {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/dashboard/agents/${handle}/pause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string }
        setError(body.message ?? 'Failed to pause')
        return
      }
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  async function unpause() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/dashboard/agents/${handle}/unpause`, {
        method: 'POST',
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string }
        setError(body.message ?? 'Failed to unpause')
        return
      }
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack">
      <div className="row">
        <button
          type="button"
          className="btn btn-ghost"
          disabled={busy || currentMode === 'send'}
          onClick={() => pause('send')}
        >
          Pause sending
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={busy || currentMode === 'full'}
          onClick={() => pause('full')}
        >
          Pause fully
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || currentMode === 'none'}
          onClick={unpause}
        >
          Unpause
        </button>
      </div>
      {error && <p className="err">{error}</p>}
    </div>
  )
}
