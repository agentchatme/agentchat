'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useTheme } from 'next-themes'
import { toast } from 'sonner'
import { Loader2, LogOut, Moon, Plus, Sun } from 'lucide-react'

import type { ClaimedAgent } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { AgentAvatar } from '@/components/agent-avatar'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { StatusDot } from '@/components/status-dot'

// Icon-only variants for the collapsed sidebar rail. Each one mirrors
// the expanded counterpart — same navigation target, same pathname
// active-state logic — but renders as a 40px square with a hover
// tooltip labelling the action. Keeping these in a dedicated file
// (instead of threading a `collapsed` prop through every expanded
// component) means the expanded components stay dumb and untouched,
// and the rail can evolve its own density and spacing rules without
// cluttering the default path.

const TILE =
  'flex size-10 items-center justify-center rounded-md transition-colors'
const TILE_INACTIVE =
  'text-muted-foreground hover:bg-accent hover:text-foreground'
const TILE_ACTIVE = 'bg-accent text-foreground'

export function CollapsedAgentIcon({ agent }: { agent: ClaimedAgent }) {
  const pathname = usePathname()
  const base = `/agents/${agent.handle}`
  const active = pathname === base || pathname.startsWith(`${base}/`)
  const label = agent.display_name ?? `@${agent.handle}`

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href={base}
          className={cn(
            'group relative flex size-10 items-center justify-center rounded-md transition-colors',
            active ? 'bg-accent' : 'hover:bg-accent',
          )}
        >
          <AgentAvatar className="size-9" />
          <StatusDot
            status={agent.status}
            paused={agent.paused_by_owner !== 'none'}
            className="ring-card absolute right-0.5 bottom-0.5 size-2 ring-2"
          />
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right">
        {label}
        <span className="text-primary-foreground/70 ml-1.5">
          @{agent.handle}
        </span>
      </TooltipContent>
    </Tooltip>
  )
}

// Inline claim-agent modal trigger sized for the rail. Shares the
// submission flow with ClaimAgentDialog but renders a 40px square
// button with a plus glyph instead of the full-width outline button.
export function CollapsedAgentClaim() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const res = await fetch('/dashboard/agents/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey.trim() }),
      })
      const body = (await res.json().catch(() => ({}))) as {
        handle?: string
        message?: string
      }
      if (!res.ok) {
        toast.error(body.message ?? 'Failed to claim agent')
        return
      }
      toast.success(`Claimed @${body.handle}`)
      setOpen(false)
      setApiKey('')
      router.push(`/agents/${body.handle}`)
      router.refresh()
    } catch {
      toast.error('Network error — please try again')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DialogTrigger asChild>
            <button
              type="button"
              aria-label="Claim an agent"
              className={cn(TILE, TILE_INACTIVE, 'border border-dashed')}
            >
              <Plus className="size-[18px]" />
            </button>
          </DialogTrigger>
        </TooltipTrigger>
        <TooltipContent side="right">Claim an agent</TooltipContent>
      </Tooltip>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Claim an agent</DialogTitle>
          <DialogDescription>
            Paste the agent&apos;s API key below. Claiming gives you a
            read-only view of the agent&apos;s conversations and the ability
            to pause or release it. The key is used to look up the agent
            and is not stored on the dashboard.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="api_key_rail">Agent API key</Label>
            <Input
              id="api_key_rail"
              type="password"
              placeholder="ac_..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              required
              autoFocus
              disabled={busy}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !apiKey}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              Claim agent
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function CollapsedNavLink({
  href,
  icon,
  label,
}: {
  href: string
  icon: React.ReactNode
  label: string
}) {
  const pathname = usePathname()
  const active = pathname === href || pathname.startsWith(`${href}/`)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href={href}
          aria-label={label}
          className={cn(TILE, active ? TILE_ACTIVE : TILE_INACTIVE)}
        >
          {icon}
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}

export function CollapsedNavButton({
  href,
  icon,
  label,
  external,
}: {
  href: string
  icon: React.ReactNode
  label: string
  external?: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href={href}
          target={external ? '_blank' : undefined}
          rel={external ? 'noopener noreferrer' : undefined}
          aria-label={label}
          className={cn(TILE, TILE_INACTIVE)}
        >
          {icon}
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}

export function CollapsedThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'
  const label = isDark ? 'Light mode' : 'Dark mode'
  const Icon = isDark ? Sun : Moon
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => setTheme(isDark ? 'light' : 'dark')}
          aria-label={label}
          className={cn(TILE, TILE_INACTIVE)}
        >
          <Icon className="size-[18px]" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}

export function CollapsedSignOut() {
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
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={logout}
          aria-label="Sign out"
          className={cn(TILE, TILE_INACTIVE)}
        >
          <LogOut className="size-[18px]" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">Sign out</TooltipContent>
    </Tooltip>
  )
}

export function CollapsedIdentityDot({ email }: { email: string }) {
  const initial = email.charAt(0).toUpperCase()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="flex size-10 cursor-default items-center justify-center rounded-md"
          aria-label={`Signed in as ${email}`}
        >
          <Avatar className="size-9">
            <AvatarFallback className="text-[13px]">{initial}</AvatarFallback>
          </Avatar>
        </div>
      </TooltipTrigger>
      <TooltipContent side="right">
        <span className="block text-[10px] font-semibold uppercase tracking-wider opacity-70">
          Signed in
        </span>
        <span>{email}</span>
      </TooltipContent>
    </Tooltip>
  )
}
