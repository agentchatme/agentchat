'use client'

import { useEffect } from 'react'

// Writes `ac_last_agent` to document.cookie on mount so the next
// visit to the home route (§3.1.2) can redirect straight back to the
// agent the owner was looking at last. The home page reads this
// cookie in an RSC — since document.cookie writes flow through the
// same cookie jar Next sees on the next request, no api-server round
// trip is needed. Thirty days is arbitrary; long enough to survive
// casual browser restarts, short enough to age out if an owner
// releases a claim and never comes back.

export function LastAgentTracker({ handle }: { handle: string }) {
  useEffect(() => {
    const maxAge = 60 * 60 * 24 * 30
    document.cookie = `ac_last_agent=${encodeURIComponent(handle)}; path=/; max-age=${maxAge}; samesite=lax`
  }, [handle])

  return null
}
