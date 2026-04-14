import type { AgentStatus, PauseMode } from '../lib/types'

export function StatusBadge({ status }: { status: AgentStatus }) {
  const cls =
    status === 'active'
      ? 'badge-active'
      : status === 'restricted'
        ? 'badge-restricted'
        : status === 'suspended'
          ? 'badge-suspended'
          : 'badge-muted'
  return <span className={`badge ${cls}`}>{status}</span>
}

export function PauseBadge({ mode }: { mode: PauseMode }) {
  if (mode === 'none') return null
  const label = mode === 'send' ? 'Send paused' : 'Fully paused'
  const cls = mode === 'send' ? 'badge-paused-send' : 'badge-paused-full'
  return <span className={`badge ${cls}`}>{label}</span>
}
