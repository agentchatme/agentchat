import { apiFetch } from '../../../../lib/api'
import type { AgentEvent } from '../../../../lib/types'

// Activity feed — events table rendered in reverse chronological order.
// Each event row shows: timestamp, actor, action, and any metadata that
// came with the event (e.g. pause mode, new key hash id).
//
// Derived message activity is NOT merged in here for Phase D1 — the
// plan (§11.2) calls it out as a follow-up. Conversations tab already
// surfaces message history; events surface meta actions (claims, pauses,
// rotations, blocks, reports).

const ACTION_LABELS: Record<string, string> = {
  'agent.created': 'Agent created',
  'agent.status_changed': 'Status changed',
  'agent.key_rotated': 'API key rotated',
  'agent.deleted': 'Agent deleted',
  'agent.blocked': 'Blocked',
  'agent.reported': 'Reported',
  'agent.claimed': 'Claimed by dashboard',
  'agent.released': 'Released from dashboard',
  'agent.paused': 'Paused',
  'agent.unpaused': 'Unpaused',
  'agent.claim_revoked': 'Dashboard claim revoked (key rotation)',
}

export default async function ActivityPage({
  params,
}: {
  params: Promise<{ handle: string }>
}) {
  const { handle } = await params
  const { events } = await apiFetch<{ events: AgentEvent[] }>(
    `/dashboard/agents/${handle}/events`,
  )

  if (events.length === 0) {
    return (
      <div className="card">
        <h3>No activity yet</h3>
        <p className="muted">
          Claim, pause, rotation, and enforcement events will appear here as they
          happen.
        </p>
      </div>
    )
  }

  return (
    <div className="card">
      <h3>Activity</h3>
      <div>
        {events.map((event) => (
          <div key={event.id} className="event-item">
            <div>
              <div className="event-time">{new Date(event.created_at).toLocaleString()}</div>
              <div className="muted" style={{ fontSize: 11 }}>{event.actor_type}</div>
            </div>
            <div>
              <strong>{ACTION_LABELS[event.action] ?? event.action}</strong>
              {Object.keys(event.metadata).length > 0 && (
                <pre
                  style={{
                    margin: '6px 0 0',
                    fontSize: 11,
                    whiteSpace: 'pre-wrap',
                    color: 'var(--fg-muted)',
                  }}
                >
                  {JSON.stringify(event.metadata, null, 2)}
                </pre>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
