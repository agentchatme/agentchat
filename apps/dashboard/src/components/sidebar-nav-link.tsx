'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { cn } from '@/lib/utils'

// Thin wrapper so the active-state styling is pathname-aware. The
// sidebar itself is a server component — this island is the only
// thing that needs to know the current route. Icon comes in as a
// rendered React element (not a component reference) so the server
// can evaluate lucide's forwardRef in its own tree and the crossing
// into this client boundary carries plain serializable props.

export function SidebarNavLink({
  href,
  children,
}: {
  href: string
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const active = pathname === href || pathname.startsWith(`${href}/`)

  return (
    <Link
      href={href}
      className={cn(
        'flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors',
        active
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      {children}
    </Link>
  )
}
