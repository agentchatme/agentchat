'use client'

import type { CSSProperties, MouseEvent } from 'react'

import { useOpenProfile } from '@/lib/profile-drawer-context'
import { cn } from '@/lib/utils'

// Thin wrapper for "clicking this avatar opens the profile drawer".
// Used in places where the surrounding markup is server-rendered
// (SenderHeader inside message-thread, ThreadHeader at the top of a
// conversation) — extracting just the click target here keeps the
// parent purely SSR.
//
// The button itself owns no visual styling beyond the focus ring; the
// children (the actual <Avatar/>) carry the size and color so swapping
// in a 5x5 sender badge or a 24x24 thread peer renders identically to
// the static version. stopPropagation prevents bubble-up into a parent
// <Link> (e.g. inside a conversation list row).

export function ClickableProfileAvatar({
  handle,
  ariaLabel,
  className,
  style,
  children,
}: {
  handle: string
  ariaLabel?: string
  className?: string
  style?: CSSProperties
  children: React.ReactNode
}) {
  const openProfile = useOpenProfile()

  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault()
    e.stopPropagation()
    openProfile(handle)
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel ?? `Open profile for @${handle}`}
      className={cn(
        'focus-visible:ring-ring rounded-full transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
        className,
      )}
      style={style}
    >
      {children}
    </button>
  )
}
