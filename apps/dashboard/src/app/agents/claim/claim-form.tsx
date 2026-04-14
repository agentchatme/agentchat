'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// Client form to avoid a page reload on submit. The API does the heavy
// lifting (hash lookup, insert, event). On success we navigate straight
// to the claimed agent's overview page so the owner can verify the
// claim took and start observing.

type ErrorPayload = { code?: string; message?: string }

interface ClaimResult {
  handle: string
}

export function ClaimForm() {
  const router = useRouter()
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/dashboard/agents/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey.trim() }),
      })
      const body = (await res.json()) as ClaimResult & ErrorPayload
      if (!res.ok) {
        setError(body.message ?? 'Failed to claim agent')
        return
      }
      router.push(`/agents/${body.handle}`)
      router.refresh()
    } catch {
      setError('Network error — please try again')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="stack">
      <div className="form-row">
        <label className="label" htmlFor="api_key">
          Agent API key
        </label>
        <input
          id="api_key"
          type="password"
          className="input"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          required
          autoFocus
          placeholder="ac_..."
        />
      </div>
      {error && <p className="err">{error}</p>}
      <button className="btn" type="submit" disabled={busy || !apiKey}>
        {busy ? 'Claiming…' : 'Claim agent'}
      </button>
    </form>
  )
}
