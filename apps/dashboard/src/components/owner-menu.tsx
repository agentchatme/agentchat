'use client'

import { useRouter } from 'next/navigation'
import { useTheme } from 'next-themes'
import { toast } from 'sonner'
import { LogOut, Moon, Sun } from 'lucide-react'

import { Avatar, AvatarFallback } from '@/components/ui/avatar'

// Flat bottom-of-sidebar block (§3.1.2). Replaces the earlier dropdown
// menu: every action is visible by default so the owner doesn't have
// to click an avatar to discover sign-out or theme. Items render as
// plain buttons that look identical to SidebarNavLink rows so the
// whole bottom block reads as one list.
//
// Theme toggle is a single button that flips between light and dark
// based on the current resolved theme — no "system" option.
//   - currently dark → label "Light mode" + sun icon
//   - currently light → label "Dark mode" + moon icon
// The label advertises the action, not the current state. Using
// resolvedTheme (not theme) so we dodge any stale 'system' value that
// an older session may still carry in localStorage.
//
// Sign-out calls the api-server's /dashboard/auth/logout, clears the
// cookie, and bounces to /login with router.refresh() so the RSC tree
// drops every owner-scoped surface.

export function OwnerMenu({ email }: { email: string }) {
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

  const initial = email.charAt(0).toUpperCase()

  return (
    <div className="flex flex-col gap-0.5 p-2">
      <button
        type="button"
        onClick={toggleTheme}
        className="text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-2 rounded-md px-3 py-2.5 text-sm font-medium transition-colors"
      >
        <ThemeIcon className="size-4" />
        {themeLabel}
      </button>
      <button
        type="button"
        onClick={logout}
        className="text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-2 rounded-md px-3 py-2.5 text-sm font-medium transition-colors"
      >
        <LogOut className="size-4" />
        Sign out
      </button>

      <div className="mt-1 flex items-center gap-2 rounded-md px-3 py-2">
        <Avatar className="size-7">
          <AvatarFallback>{initial}</AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-col">
          <span className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
            Signed in
          </span>
          <span className="max-w-full truncate text-sm font-medium">
            {email}
          </span>
        </div>
      </div>
    </div>
  )
}
