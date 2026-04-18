'use client'

import { useEffect, useState } from 'react'

import type { AgentPublicProfile } from '@/lib/types'
import { describePresence, PRESENCE_TONE_CLASS } from '@/lib/describe-presence'
import { cn } from '@/lib/utils'

// Live presence subtitle for the DM thread header. Renders the same
// "Active now / Last seen X ago / nothing" rule the profile drawer
// uses, polled at 60s — same cadence Telegram Web uses for its
// header subtitle. The cheap render-time fetch was rejected because
// a stale "Active now" badge that never refreshes during dwell is
// worse UX than no badge at all.
//
// Source: GET /dashboard/agents/:owner/profiles/:peer — the same
// endpoint that backs the profile drawer. Keeps every presence read
// behind the visibility-gated RPC, which means there's no new attack
// surface to audit.
//
// Falls back silently to the static `@handle` subtitle until the
// first fetch lands so the header never flashes a placeholder. After
// that, this overrides the static subtitle (passed in as
// `fallback`) only when there's something to say — never displays
// "offline" for an agent that has never connected, matching the
// drawer's rule.

const POLL_INTERVAL_MS = 60_000

export function PeerPresenceLine({
  ownerHandle,
  peerHandle,
  fallback,
}: {
  ownerHandle: string
  peerHandle: string
  // Subtitle rendered when presence is unknown OR the agent is offline
  // with no last_seen (i.e. has never connected) — typically `@handle`.
  fallback: string | null
}) {
  const [presence, setPresence] = useState<AgentPublicProfile['presence'] | null>(null)

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()

    async function load() {
      try {
        const res = await fetch(
          `/dashboard/agents/${ownerHandle}/profiles/${peerHandle}`,
          { signal: controller.signal, cache: 'no-store' },
        )
        if (!res.ok) return
        const body = (await res.json()) as AgentPublicProfile
        if (!cancelled) setPresence(body.presence)
      } catch {
        // Network blip — keep the last known value rather than flashing
        // back to fallback. The next tick will retry.
      }
    }

    void load()
    const id = setInterval(load, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      controller.abort()
      clearInterval(id)
    }
  }, [ownerHandle, peerHandle])

  const live = presence ? describePresence(presence) : null

  if (live) {
    return (
      <span className={cn('truncate text-[12px] leading-tight', PRESENCE_TONE_CLASS[live.tone])}>
        {live.text}
      </span>
    )
  }
  if (!fallback) return null
  return (
    <span className="text-muted-foreground truncate text-[12px] leading-tight">
      {fallback}
    </span>
  )
}
