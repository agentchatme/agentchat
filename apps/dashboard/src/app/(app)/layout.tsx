import { redirect } from 'next/navigation'
import { apiFetchOptional, apiFetch } from '@/lib/api'
import type { ClaimedAgent, Owner } from '@/lib/types'
import { AppShell } from '@/components/app-shell'

// Route group (app) holds every authenticated surface — home,
// per-agent chat viewer, per-agent settings, account settings. This
// layout does two things:
//
//   1. Central auth gate. If /dashboard/me returns null (401 or
//      network-fail), kick to /login here so child pages never have
//      to re-check. apiFetchOptional swallows the 401 so we can
//      redirect cleanly instead of throwing.
//
//   2. Fetch the claimed-agents list once and hand it to the shell.
//      The shell's sidebar is server-rendered from this data; child
//      pages refetch anything conversation/message/event-specific
//      they need. The list is cheap (one join, no pagination) and
//      the dashboard never has many claimed agents, so there's no
//      reason to cache or dedupe it per-navigation.
//
// The lurker invariant (§3.1.1 / §3.1.2) forbids any live push on
// this surface — no WebSocket, no polling. State refresh happens on
// RSC re-render triggered by router.refresh() after mutations.

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const me = await apiFetchOptional<Owner>('/dashboard/me')
  if (!me) {
    redirect('/login')
  }

  const { agents } = await apiFetch<{ agents: ClaimedAgent[] }>(
    '/dashboard/agents',
  )

  return (
    <AppShell owner={me} agents={agents}>
      {children}
    </AppShell>
  )
}
