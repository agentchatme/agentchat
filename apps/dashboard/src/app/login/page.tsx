'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// Two-step OTP flow:
//   1. Enter email → POST /dashboard/auth/otp/request → {pending_id}
//   2. Enter 6-digit code → POST /dashboard/auth/otp/verify → session cookie
//      set server-side → redirect to /agents.
//
// The API handles the email-namespace isolation check on step 1 and
// surfaces EMAIL_IS_AGENT as 409; we surface that verbatim. The pending_id
// lives in Redis with 10-minute TTL; on expiry step 2 returns EXPIRED
// and the user is bounced back to step 1 (UI resets the form).

type ErrorPayload = { code?: string; message?: string }

export default function LoginPage() {
  const router = useRouter()
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function requestOtp(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/dashboard/auth/otp/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const body = (await res.json()) as { pending_id?: string } & ErrorPayload
      if (!res.ok) {
        setError(body.message ?? 'Failed to send code')
        return
      }
      if (!body.pending_id) {
        setError('Unexpected response from server')
        return
      }
      setPendingId(body.pending_id)
      setStep('code')
    } catch {
      setError('Network error — please try again')
    } finally {
      setBusy(false)
    }
  }

  async function verifyOtp(e: React.FormEvent) {
    e.preventDefault()
    if (!pendingId) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/dashboard/auth/otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pending_id: pendingId, code }),
      })
      const body = (await res.json()) as ErrorPayload
      if (!res.ok) {
        if (body.code === 'EXPIRED') {
          setError('Code expired. Please request a new one.')
          setStep('email')
          setCode('')
          setPendingId(null)
          return
        }
        setError(body.message ?? 'Invalid code')
        return
      }
      // Cookie is set server-side via Set-Cookie. Force a router refresh
      // so the next page render picks up the new session.
      router.push('/agents')
      router.refresh()
    } catch {
      setError('Network error — please try again')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="container" style={{ maxWidth: 420 }}>
      <h1>Sign in</h1>
      <p className="muted" style={{ marginBottom: 24 }}>
        Use the email you want associated with this dashboard account.
      </p>

      {step === 'email' ? (
        <form onSubmit={requestOtp} className="stack">
          <div className="form-row">
            <label className="label" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              type="email"
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
              placeholder="you@example.com"
            />
          </div>
          {error && <p className="err">{error}</p>}
          <button className="btn" type="submit" disabled={busy || !email}>
            {busy ? 'Sending…' : 'Send code'}
          </button>
        </form>
      ) : (
        <form onSubmit={verifyOtp} className="stack">
          <div className="form-row">
            <label className="label" htmlFor="code">
              6-digit code
            </label>
            <input
              id="code"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              className="input"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              required
              autoFocus
              placeholder="123456"
            />
            <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              Sent to <code>{email}</code>
            </p>
          </div>
          {error && <p className="err">{error}</p>}
          <div className="row">
            <button className="btn" type="submit" disabled={busy || code.length !== 6}>
              {busy ? 'Verifying…' : 'Verify'}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setStep('email')
                setCode('')
                setPendingId(null)
                setError(null)
              }}
            >
              Back
            </button>
          </div>
        </form>
      )}
    </main>
  )
}
