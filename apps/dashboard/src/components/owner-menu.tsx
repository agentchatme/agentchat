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
    <div className="flex flex-col gap-1 p-3">
      <button
        type="button"
        onClick={toggleTheme}
        className="text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors"
      >
        <ThemeIcon className="size-[18px]" />
        {themeLabel}
      </button>
      <button
        type="button"
        onClick={logout}
        className="text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors"
      >
        <LogOut className="size-[18px]" />
        Sign out
      </button>

      <div className="mt-2 flex items-center gap-3 rounded-md border bg-background/40 px-3 py-2.5">
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
    </div>
  )
}
