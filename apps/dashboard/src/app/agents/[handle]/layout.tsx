import { Nav } from '../../../components/nav'
import { AgentSubNav } from './sub-nav'

// Shared chrome for every /agents/:handle route — top nav, sub-nav for
// the three detail views (overview, conversations, activity), then the
// child page. The sub-nav is its own client component so the active
// link can be computed from pathname on the client.

export default async function AgentLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ handle: string }>
}) {
  const { handle } = await params
  return (
    <>
      <Nav />
      <main className="container">
        <AgentSubNav handle={handle} />
        {children}
      </main>
    </>
  )
}
