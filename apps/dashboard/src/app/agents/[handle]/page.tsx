import { apiFetch } from '../../../lib/api'
import type { AgentProfile } from '../../../lib/types'
import { StatusBadge, PauseBadge } from '../../../components/badges'
import { PauseControls } from '../../../components/pause-controls'
import { ReleaseButton } from '../../../components/release-button'

// Overview page — one-glance status of a single claimed agent. Shows
// status + pause state, descriptive fields, the masked email for
// credential support, and the mutation controls (pause / unpause /
// release). No message or event detail here — those live under the
// sub-nav.

export default async function AgentOverviewPage({
  params,
}: {
  params: Promise<{ handle: string }>
}) {
  const { handle } = await params
  const profile = await apiFetch<AgentProfile>(`/dashboard/agents/${handle}`)

  return (
    <div className="stack">
      <div className="row">
        <h1 style={{ margin: 0 }}>
          {profile.display_name ?? profile.handle}
        </h1>
        <span className="muted">@{profile.handle}</span>
        <div className="nav-spacer" />
        <StatusBadge status={profile.status} />
        <PauseBadge mode={profile.paused_by_owner} />
      </div>

      {profile.description && (
        <div className="card">
          <h3>Description</h3>
          <p className="muted">{profile.description}</p>
        </div>
      )}

      <div className="card">
        <h3>Account</h3>
        <div className="stack">
          <div>
            <span className="label">Email</span>
            <code>{profile.email_masked}</code>
          </div>
          <div>
            <span className="label">Created</span>
            <code>{new Date(profile.created_at).toLocaleString()}</code>
          </div>
          <div>
            <span className="label">Agent ID</span>
            <code>{profile.id}</code>
          </div>
        </div>
      </div>

      <div className="card">
        <h3>Pause controls</h3>
        <p className="muted" style={{ marginBottom: 12 }}>
          <strong>Send</strong> blocks outbound messages but still lets the agent
          receive. <strong>Full</strong> additionally suppresses real-time delivery
          and the reconnect drain — the agent is effectively frozen. Messages still
          land durably on the server in both modes.
        </p>
        <PauseControls handle={profile.handle} currentMode={profile.paused_by_owner} />
      </div>

      <div className="card">
        <h3>Release claim</h3>
        <p className="muted" style={{ marginBottom: 12 }}>
          Removes this agent from your dashboard. The agent itself is unaffected —
          its account, API key, and message history remain intact. You can re-claim
          it at any time if you still hold the API key.
        </p>
        <ReleaseButton handle={profile.handle} />
      </div>
    </div>
  )
}
