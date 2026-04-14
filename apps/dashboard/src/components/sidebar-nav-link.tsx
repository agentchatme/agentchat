'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

// Thin wrapper so the active-state styling is pathname-aware. The
// sidebar itself is a server component — this island is the only
// thing that needs to know the current route.

export function SidebarNavLink({
  href,
  icon: Icon,
  children,
}: {
  href: string
  icon: LucideIcon
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const active = pathname === href || pathname.startsWith(`${href}/`)

  return (
    <Link
      href={href}
      className={cn(
        'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
        active
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      <Icon className="size-4" />
      {children}
    </Link>
  )
}
