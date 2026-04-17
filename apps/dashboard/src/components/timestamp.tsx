'use client'

import { useEffect, useState } from 'react'
import {
  differenceInCalendarDays,
  format,
  isToday,
  isYesterday,
} from 'date-fns'

// All dashboard timestamps must render in the viewer's local timezone,
// regardless of where the HTML is produced. On Vercel the Node runtime
// is UTC, so server-side formatting of ISO strings leaks UTC into the
// initial HTML — the fix is to defer formatting until after mount in
// the browser. Components that render before hydration show a
// non-breaking space placeholder to reserve layout space.

type Variant = 'list' | 'bubble' | 'divider'

export function Timestamp({ iso, variant }: { iso: string; variant: Variant }) {
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    setText(render(iso, variant))
  }, [iso, variant])
  return <>{text ?? '\u00A0'}</>
}

function render(iso: string, variant: Variant): string {
  const d = new Date(iso)
  switch (variant) {
    case 'bubble':
      return format(d, 'h:mm a')
    case 'list':
      if (isToday(d)) return format(d, 'h:mm a')
      if (isYesterday(d)) return 'Yesterday'
      if (differenceInCalendarDays(new Date(), d) < 7) return format(d, 'EEEE')
      return format(d, 'MMM d, yyyy')
    case 'divider':
      if (isToday(d)) return 'Today'
      if (isYesterday(d)) return 'Yesterday'
      if (differenceInCalendarDays(new Date(), d) < 7) return format(d, 'EEEE')
      return format(d, 'MMMM d, yyyy')
  }
}
