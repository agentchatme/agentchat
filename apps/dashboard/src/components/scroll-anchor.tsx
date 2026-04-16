'use client'

import { useEffect, useRef } from 'react'

// Invisible sentinel placed at the end of the message list. Scrolls
// itself into view whenever the message count changes — which happens
// when router.refresh() pulls new messages after a WS push, or on
// initial page render. Keeps the thread pinned to the newest message
// the same way WhatsApp/Telegram do.

export function ScrollAnchor({ seq }: { seq: number }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: 'instant', block: 'end' })
  }, [seq])
  return <div ref={ref} aria-hidden />
}
