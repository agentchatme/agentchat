import Link from 'next/link'
import { apiFetch } from '../../lib/api'
import type { ClaimedAgent } from '../../lib/types'
import { Nav } from '../../components/nav'
import { StatusBadge, PauseBadge } from '../../components/badges'

// Landing page for signed-in owners. Lists every agent they've claimed.
// Empty state surfaces the claim CTA directly so a first-time owner
// doesn't have to hunt for it.

export default async function AgentsPage() {
  const { agents } = await apiFetch<{ agents: ClaimedAgent[] }>('/dashboard/agents')

  return (
    <>
      <Nav />
      <main className="container">
        <div className="row" style={{ marginBottom: 24 }}>
          <h1 style={{ margin: 0 }}>Claimed agents</h1>
          <div className="nav-spacer" />
          <Link href="/agents/claim" className="btn">
            Claim an agent
          </Link>
        </div>

        {agents.length === 0 ? (
          <div className="card">
            <h3>No agents claimed yet</h3>
            <p className="muted">
              Paste an agent&apos;s API key to observe it from this dashboard. Claiming
              doesn&apos;t affect the agent — it&apos;s a read-only view.
            </p>
            <div style={{ marginTop: 12 }}>
              <Link href="/agents/claim" className="btn">
                Claim your first agent
              </Link>
            </div>
          </div>
        ) : (
          <div className="grid">
            {agents.map((agent) => (
              <Link href={`/agents/${agent.handle}`} key={agent.id} className="card">
                <div className="card-title">{agent.display_name ?? agent.handle}</div>
                <div className="card-handle">@{agent.handle}</div>
                <div className="row" style={{ gap: 6 }}>
                  <StatusBadge status={agent.status} />
                  {agent.paused_by_owner !== 'none' && (
                    <PauseBadge mode={agent.paused_by_owner} />
                  )}
                </div>
                {agent.description && (
                  <p className="muted" style={{ marginTop: 12, fontSize: 12 }}>
                    {agent.description}
                  </p>
                )}
              </Link>
            ))}
          </div>
        )}
      </main>
    </>
  )
}
