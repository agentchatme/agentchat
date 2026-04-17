'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useTheme } from 'next-themes'
import { toast } from 'sonner'
import { Loader2, Moon, Plus, Sun } from 'lucide-react'

import type { ClaimedAgent } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { StatusDot } from '@/components/status-dot'
import { OwnerMenuItems } from '@/components/owner-menu'

// Icon-only variants for the collapsed sidebar rail. Each mirrors the
// expanded counterpart — same navigation target, same active-state
// logic — but renders as a 40px square with a hover tooltip. Keeping
// these in a dedicated file means the expanded components stay dumb
// and the rail can evolve its own density rules.

const TILE =
  'flex size-10 items-center justify-center rounded-md transition-colors'
const TILE_INACTIVE =
  'text-muted-foreground hover:bg-accent hover:text-foreground'

export function CollapsedAgentIcon({ agent }: { agent: ClaimedAgent }) {
  const pathname = usePathname()
  const base = `/agents/${agent.handle}`
  const active = pathname === base || pathname.startsWith(`${base}/`)
  const initial = (agent.display_name ?? agent.handle).charAt(0).toUpperCase()
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
          <Avatar className="size-9">
            {agent.avatar_url ? (
              <AvatarImage src={agent.avatar_url} alt={label} />
            ) : null}
            <AvatarFallback className="text-[13px]">{initial}</AvatarFallback>
          </Avatar>
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

// Identity avatar at the foot of the collapsed rail. Click opens the
// same Account settings + Sign out menu the expanded OwnerIdentityMenu
// uses; anchored side=right so it opens into the main pane instead of
// off-screen to the left.
export function CollapsedOwnerMenu({ email }: { email: string }) {
  const initial = email.charAt(0).toUpperCase()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Account menu — signed in as ${email}`}
          className={cn(TILE, TILE_INACTIVE)}
        >
          <Avatar className="size-9">
            <AvatarFallback className="text-[13px]">{initial}</AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="end" className="min-w-56">
        <OwnerMenuItems />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
