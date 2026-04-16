import { redirect } from 'next/navigation'
import { getBootstrap } from '@/lib/api'
import { AppShell } from '@/components/app-shell'
import { DashboardWsProvider } from '@/components/dashboard-ws-provider'

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
// Live updates: DashboardWsProvider holds one WebSocket for the life
// of this layout and router.refresh()es on message.new events from
// the api-server. The lurker invariant still holds — the channel is
// one-way server→client and scoped to the signed-in owner via a
// one-shot ticket (see WIRE-CONTRACT.md).

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
      <DashboardWsProvider>{children}</DashboardWsProvider>
    </AppShell>
  )
}
