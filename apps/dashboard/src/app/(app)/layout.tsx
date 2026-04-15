import { redirect } from 'next/navigation'
import { getBootstrap } from '@/lib/api'
import { AppShell } from '@/components/app-shell'

// Route group (app) holds every authenticated surface — home,
// per-agent chat viewer, per-agent settings, account settings. This
// layout does two things:
//
//   1. Central auth gate. If /dashboard/bootstrap returns null (401
//      or network-fail), kick to /login here so child pages never
//      have to re-check.
//
//   2. Fetch the signed-in owner + claimed-agents list in a single
//      round-trip via /dashboard/bootstrap, and hand it to the shell.
//      The sidebar is server-rendered from this data. Child pages
//      that need the same owner/agents data call getBootstrap()
//      again — React.cache() dedupes within the same render tree so
//      there is exactly one network call per navigation.
//
// The lurker invariant (§3.1.1 / §3.1.2) forbids any live push on
// this surface — no WebSocket, no polling. State refresh happens on
// RSC re-render triggered by router.refresh() after mutations.

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const bootstrap = await getBootstrap()
  if (!bootstrap) {
    redirect('/login')
  }

  return (
    <AppShell owner={bootstrap.owner} agents={bootstrap.agents}>
      {children}
    </AppShell>
  )
}
