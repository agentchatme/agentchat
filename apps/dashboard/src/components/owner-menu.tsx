'use client'

import { useRouter } from 'next/navigation'
import { useTheme } from 'next-themes'
import { toast } from 'sonner'
import { LogOut, Monitor, Moon, Sun, User } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'

// Owner menu in the sidebar footer. Shows the signed-in email and
// hosts two categories of action: theme selection and sign-out.
// Account settings has its own sidebar entry up top — intentional
// duplication: the top-block link is the discoverable path, the
// menu item is the muscle-memory path.
//
// Sign-out calls the api-server's /dashboard/auth/logout, which
// clears the cookie. We push to /login and refresh so the RSC tree
// drops every owner-scoped surface.

export function OwnerMenu({ email }: { email: string }) {
  const router = useRouter()
  const { setTheme } = useTheme()

  async function logout() {
    try {
      await fetch('/dashboard/auth/logout', { method: 'POST' })
    } catch {
      // Even if the logout call fails, clear client state and
      // bounce to /login so the user isn't stuck looking at a
      // stale session.
      toast.error('Network error — signing out locally anyway')
    }
    router.push('/login')
    router.refresh()
  }

  const initial = email.charAt(0).toUpperCase()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="h-auto w-full justify-start gap-2 px-2 py-2"
        >
          <Avatar className="size-7">
            <AvatarFallback>{initial}</AvatarFallback>
          </Avatar>
          <div className="flex min-w-0 flex-col items-start">
            <span className="text-muted-foreground truncate text-xs">
              Signed in as
            </span>
            <span className="max-w-full truncate text-xs font-medium">
              {email}
            </span>
          </div>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-56">
        <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
          {email}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => router.push('/account')}>
            <User />
            Account settings
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
          Theme
        </DropdownMenuLabel>
        <DropdownMenuItem onClick={() => setTheme('light')}>
          <Sun />
          Light
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('dark')}>
          <Moon />
          Dark
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('system')}>
          <Monitor />
          System
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={logout}>
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
