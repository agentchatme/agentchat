'use client'

import Link from 'next/link'
import { MoreVertical, ShieldOff, UserSquare } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

// Three-dots overflow menu that sits next to the Settings gear in
// the chat header. Owns two items — Contact list and Block list —
// which navigate to the workspace sibling routes. The menu itself is
// a thin client wrapper around Radix's DropdownMenu; keeping it in
// its own file lets the parent ChatHeader stay a server component.
//
// Why not put Settings in here too? Settings is the primary
// affordance — it gets its own persistent icon button so the owner
// can reach it with one click from any agent view. The overflow
// menu is strictly for the less-frequent sibling views.

export function ChatHeaderMenu({ handle }: { handle: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="More">
          <MoreVertical className="size-[18px]" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem asChild>
          <Link href={`/agents/${handle}/contacts`} className="cursor-pointer">
            <UserSquare className="size-4" />
            Contact list
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href={`/agents/${handle}/blocks`} className="cursor-pointer">
            <ShieldOff className="size-4" />
            Block list
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
