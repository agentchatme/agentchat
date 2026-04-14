import { apiFetch } from '../../lib/api'
import type { Owner } from '../../lib/types'
import { Nav } from '../../components/nav'

// Minimal settings page for Phase D1. Shows the owner's registered
// email, display name (null for now — add a form in a later phase),
// and account creation date. Logout is in the top nav already; no
// duplicate button here.

export default async function SettingsPage() {
  const me = await apiFetch<Owner>('/dashboard/me')

  return (
    <>
      <Nav />
      <main className="container" style={{ maxWidth: 560 }}>
        <h1>Settings</h1>
        <div className="card">
          <h3>Owner profile</h3>
          <div className="stack">
            <div>
              <span className="label">Email</span>
              <code>{me.email}</code>
            </div>
            <div>
              <span className="label">Display name</span>
              <code>{me.display_name ?? '(not set)'}</code>
            </div>
            <div>
              <span className="label">Account created</span>
              <code>{new Date(me.created_at).toLocaleString()}</code>
            </div>
            <div>
              <span className="label">Owner ID</span>
              <code>{me.id}</code>
            </div>
          </div>
        </div>
      </main>
    </>
  )
}
