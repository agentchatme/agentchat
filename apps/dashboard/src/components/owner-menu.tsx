'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTheme } from 'next-themes'
import { toast } from 'sonner'
import { ChevronsUpDown, LogOut, Moon, Settings, Sun } from 'lucide-react'

import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

const navItemClass =
  'text-muted-foreground hover:bg-accent hover:text-foreground flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors'

export function ThemeToggleItem() {
  const { resolvedTheme, setTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'
  const label = isDark ? 'Light mode' : 'Dark mode'
  const Icon = isDark ? Sun : Moon
  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      className={navItemClass}
    >
      <Icon className="size-[18px]" />
      {label}
    </button>
  )
}

// Account settings + Sign out — shared between the expanded
// OwnerIdentityMenu and the collapsed rail's identity dropdown so the
// logout flow stays in one place.
export function OwnerMenuItems() {
  const router = useRouter()

  async function logout() {
    try {
      await fetch('/dashboard/auth/logout', { method: 'POST' })
    } catch {
      toast.error('Network error — signing out locally anyway')
    }
    router.push('/login')
    router.refresh()
  }

  return (
    <>
      <DropdownMenuItem asChild>
        <Link href="/account" className="cursor-pointer">
          <Settings className="size-4" />
          Account settings
        </Link>
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={logout} variant="destructive">
        <LogOut className="size-4" />
        Sign out
      </DropdownMenuItem>
    </>
  )
}

// Signed-in pill at the foot of the expanded sidebar. Clicking it
// opens a dropdown anchored to the top edge so the menu expands
// upward — the pill already sits at the bottom of the sidebar and a
// bottom-anchored menu would clip against the viewport.
export function OwnerIdentityMenu({ email }: { email: string }) {
  const initial = email.charAt(0).toUpperCase()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Account menu"
          className="hover:bg-accent focus-visible:ring-ring bg-background/40 flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          <Avatar className="size-9">
            <AvatarFallback>{initial}</AvatarFallback>
          </Avatar>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">
              Signed in
            </span>
            <span className="max-w-full truncate text-sm font-medium">
              {email}
            </span>
          </div>
          <ChevronsUpDown className="text-muted-foreground size-4 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
      >
        <OwnerMenuItems />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
