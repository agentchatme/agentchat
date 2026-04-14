'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

export function AgentSubNav({ handle }: { handle: string }) {
  const pathname = usePathname()
  const base = `/agents/${handle}`

  const isActive = (path: string) => {
    if (path === base) return pathname === base
    return pathname.startsWith(path)
  }

  return (
    <nav className="sub-nav">
      <Link href={base} className={isActive(base) ? 'active' : ''}>
        Overview
      </Link>
      <Link
        href={`${base}/conversations`}
        className={isActive(`${base}/conversations`) ? 'active' : ''}
      >
        Conversations
      </Link>
      <Link
        href={`${base}/activity`}
        className={isActive(`${base}/activity`) ? 'active' : ''}
      >
        Activity
      </Link>
    </nav>
  )
}
