'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

// Release is destructive from the dashboard's perspective (the agent
// disappears from the claimed list) but not from the agent's — the
// account is untouched. A window.confirm is enough friction; no modal
// needed for Phase D1.

export function ReleaseButton({ handle }: { handle: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function release() {
    if (!window.confirm(`Release @${handle}? You can re-claim it later if you still hold the API key.`)) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/dashboard/agents/${handle}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string }
        setError(body.message ?? 'Failed to release claim')
        return
      }
      router.push('/agents')
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button type="button" className="btn btn-danger" disabled={busy} onClick={release}>
        {busy ? 'Releasing…' : 'Release claim'}
      </button>
      {error && <p className="err">{error}</p>}
    </>
  )
}
