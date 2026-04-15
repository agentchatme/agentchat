'use client'

import { useRouter } from 'next/navigation'
import { useTheme } from 'next-themes'
import { toast } from 'sonner'
import { LogOut, Moon, Sun } from 'lucide-react'

import { Avatar, AvatarFallback } from '@/components/ui/avatar'

// The sidebar bottom is one flat list — Account settings,
// Documentation, Theme toggle, Sign out — rendered as a single <nav>
// with consistent gap/padding. OwnerMenuActions is the client-side
// piece (theme + logout) that gets slotted into that same nav, so the
// whole group reads as one section instead of splitting across
// wrapper containers. The signed-in identity card is rendered
// separately by the sidebar as a footer pill below the nav.
//
// Theme toggle flips between light and dark based on the current
// resolved theme — no "system" option. Label advertises the action,
// not the current state. Using resolvedTheme (not theme) so we dodge
// any stale 'system' value that an older session may still carry in
// localStorage.
//
// Sign-out calls the api-server's /dashboard/auth/logout, clears the
// cookie, and bounces to /login with router.refresh() so the RSC tree
// drops every owner-scoped surface.

const navItemClass =
  'text-muted-foreground hover:bg-accent hover:text-foreground flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors'

export function OwnerMenuActions() {
  const router = useRouter()
  const { resolvedTheme, setTheme } = useTheme()

  async function logout() {
    try {
      await fetch('/dashboard/auth/logout', { method: 'POST' })
    } catch {
      toast.error('Network error — signing out locally anyway')
    }
    router.push('/login')
    router.refresh()
  }

  function toggleTheme() {
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')
  }

  const isDark = resolvedTheme === 'dark'
  const themeLabel = isDark ? 'Light mode' : 'Dark mode'
  const ThemeIcon = isDark ? Sun : Moon

  return (
    <>
      <button type="button" onClick={toggleTheme} className={navItemClass}>
        <ThemeIcon className="size-[18px]" />
        {themeLabel}
      </button>
      <button type="button" onClick={logout} className={navItemClass}>
        <LogOut className="size-[18px]" />
        Sign out
      </button>
    </>
  )
}

export function OwnerIdentityCard({ email }: { email: string }) {
  const initial = email.charAt(0).toUpperCase()
  return (
    <div className="flex items-center gap-3 rounded-md border bg-background/40 px-3 py-2.5">
      <Avatar className="size-9">
        <AvatarFallback>{initial}</AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wider">
          Signed in
        </span>
        <span className="max-w-full truncate text-sm font-medium">
          {email}
        </span>
      </div>
    </div>
  )
}
