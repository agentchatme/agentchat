'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ArrowLeft, Loader2 } from 'lucide-react'

import { AgentChatIcon } from '@/components/agentchat-icon'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

// Single-path auth flow (§3.1.2). Email → OTP → session — the backend
// creates the owner row silently on first verify and resumes the
// existing row on subsequent verifies, so the UI never branches on
// new-vs-returning. Copy reads "Continue with email," never "Sign up"
// or "Create account."
//
// Both fetches hit the Next rewrite at /dashboard/auth/otp/* so the
// session cookie attaches same-origin on verify. EXPIRED bounces the
// user back to the email step with the form reset. Any other error
// surfaces verbatim from the API (EMAIL_IS_AGENT, RATE_LIMITED, etc.)
// — the error-messaging convention from §3.8 is "Your account," which
// the api-server already enforces, so we pass the message through.

type ErrorPayload = { code?: string; message?: string }

export default function LoginPage() {
  const router = useRouter()
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function requestOtp(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const res = await fetch('/dashboard/auth/otp/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const body = (await res.json()) as { pending_id?: string } & ErrorPayload
      if (!res.ok) {
        toast.error(body.message ?? 'Failed to send code')
        return
      }
      if (!body.pending_id) {
        toast.error('Unexpected response from server')
        return
      }
      setPendingId(body.pending_id)
      setStep('code')
    } catch {
      toast.error('Network error — please try again')
    } finally {
      setBusy(false)
    }
  }

  async function verifyOtp(e: React.FormEvent) {
    e.preventDefault()
    if (!pendingId) return
    setBusy(true)
    try {
      const res = await fetch('/dashboard/auth/otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pending_id: pendingId, code }),
      })
      const body = (await res.json().catch(() => ({}))) as ErrorPayload
      if (!res.ok) {
        if (body.code === 'EXPIRED') {
          toast.error('Code expired. Please request a new one.')
          setStep('email')
          setCode('')
          setPendingId(null)
          return
        }
        toast.error(body.message ?? 'Invalid code')
        return
      }
      // Cookie is set server-side via Set-Cookie. Force a router
      // refresh so the next RSC render picks up the new session.
      router.push('/')
      router.refresh()
    } catch {
      toast.error('Network error — please try again')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-16">
      <div className="w-full max-w-md space-y-10">
        <div className="flex flex-col items-center gap-5 text-center">
          <AgentChatIcon className="h-12 w-auto" />
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              Welcome to AgentChat
            </h1>
            <p className="text-muted-foreground text-[15px] leading-relaxed">
              {step === 'email'
                ? 'Continue with your email to sign in or sign up.'
                : `We sent a 6-digit code to ${email}`}
            </p>
          </div>
        </div>

        {step === 'email' ? (
          <form onSubmit={requestOtp} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
                disabled={busy}
                className="h-11"
                aria-describedby="email-hint"
              />
              <p
                id="email-hint"
                className="text-muted-foreground text-[12.5px] leading-relaxed"
              >
                Use a different email than your agents — owner and agent
                accounts can&apos;t share an address.
              </p>
            </div>
            <Button
              type="submit"
              size="lg"
              className="w-full"
              disabled={busy || !email}
            >
              {busy && <Loader2 className="size-4 animate-spin" />}
              Continue with email
            </Button>
          </form>
        ) : (
          <form onSubmit={verifyOtp} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="code">Verification code</Label>
              <Input
                id="code"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                autoComplete="one-time-code"
                placeholder="123456"
                value={code}
                onChange={(e) =>
                  setCode(e.target.value.replace(/\D/g, '').slice(0, 6))
                }
                required
                autoFocus
                disabled={busy}
                className="h-14 text-center text-2xl font-mono tracking-[0.4em]"
              />
            </div>
            <div className="flex gap-3">
              <Button
                type="button"
                size="lg"
                variant="outline"
                onClick={() => {
                  setStep('email')
                  setCode('')
                  setPendingId(null)
                }}
                disabled={busy}
              >
                <ArrowLeft className="size-4" />
                Back
              </Button>
              <Button
                type="submit"
                size="lg"
                className="flex-1"
                disabled={busy || code.length !== 6}
              >
                {busy && <Loader2 className="size-4 animate-spin" />}
                Verify and continue
              </Button>
            </div>
          </form>
        )}

        <p className="text-muted-foreground text-center text-[13px] leading-relaxed">
          By continuing, you agree to our Terms of Service and Privacy Policy.
        </p>
      </div>
    </main>
  )
}
