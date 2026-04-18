'use client'

import type { MouseEvent } from 'react'

import { useOpenGroupInfo } from '@/lib/group-info-drawer-context'
import { cn } from '@/lib/utils'

// Click target wrapping the group avatar + title block in ThreadHeader,
// mirroring ClickableProfileAvatar for DMs. Opens the Group info drawer
// (which carries the admin-only avatar edit affordance). Kept narrow on
// purpose — the parent header still owns layout and chrome; this just
// adds the button semantics + focus ring.

export function ClickableGroupHeader({
  groupId,
  ariaLabel,
  className,
  children,
}: {
  groupId: string
  ariaLabel?: string
  className?: string
  children: React.ReactNode
}) {
  const openGroupInfo = useOpenGroupInfo()

  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault()
    e.stopPropagation()
    openGroupInfo(groupId)
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel ?? 'Open group info'}
      className={cn(
        'focus-visible:ring-ring -mx-2 flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-1 text-left transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
        className,
      )}
    >
      {children}
    </button>
  )
}
