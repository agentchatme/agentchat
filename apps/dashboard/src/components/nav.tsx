import Link from 'next/link'
import { apiFetchOptional } from '../lib/api'
import type { Owner } from '../lib/types'
import { LogoutButton } from './logout-button'

// Server component — fetches /dashboard/me on every render to decide
// whether to show the logged-in nav. When the owner isn't signed in the
// call returns null and we show a minimal nav pointing to /login. All
// pages inside (agents) will themselves redirect to /login via apiFetch
// if cookies are missing, so the nav is informational only.

export async function Nav() {
  const me = await apiFetchOptional<Owner>('/dashboard/me')

  return (
    <nav className="nav">
      <Link href="/agents" className="nav-brand">
        AgentChat
      </Link>
      <div className="nav-spacer" />
      {me ? (
        <>
          <Link href="/agents">Agents</Link>
          <Link href="/agents/claim">Claim</Link>
          <Link href="/settings">Settings</Link>
          <span className="muted">{me.email}</span>
          <LogoutButton />
        </>
      ) : (
        <Link href="/login">Sign in</Link>
      )}
    </nav>
  )
}
