'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

export function LogoutButton() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function logout() {
    setBusy(true)
    try {
      await fetch('/dashboard/auth/logout', { method: 'POST' })
    } finally {
      // Whether or not the logout call succeeds, force a client refresh
      // so the server-rendered nav re-queries /dashboard/me and drops
      // the owner-specific links. Then push to /login.
      router.push('/login')
      router.refresh()
    }
  }

  return (
    <button className="btn btn-ghost" onClick={logout} disabled={busy}>
      {busy ? 'Signing out…' : 'Sign out'}
    </button>
  )
}
