import { apiFetch } from '@/lib/api'
import type { AgentProfile } from '@/lib/types'
import { ChatHeader } from '@/components/chat-header'
import { LastAgentTracker } from '@/components/last-agent-tracker'
import { AgentProfileDrawer } from '@/components/agent-profile-drawer'
import { ProfileDrawerProvider } from '@/lib/profile-drawer-context'

// Shared shell for every per-agent workspace view: chat, contacts,
// blocks. The route group `(workspace)` groups the three sibling
// routes so they share this layout — Settings lives OUTSIDE the
// group and keeps its own full-page chrome, because clicking
// Settings is "zoom into this agent's config" rather than a sibling
// workspace view.
//
// The layout owns:
//   * bg-chat-bg wrapper — visual continuity across the three views
//   * <ChatHeader /> — agent identity + Settings + three-dots menu,
//     persistent across navigation so the owner always knows which
//     agent they're inside
//   * <LastAgentTracker /> — remembers the last-viewed agent so the
//     root redirect can drop the owner back into their last context
//
// The body slot (`{children}`) is swapped as the owner navigates
// between /agents/:handle (chat), /agents/:handle/contacts, and
// /agents/:handle/blocks. Next's partial rendering means only the
// body remounts — the header stays put.
//
// We deliberately fetch the profile here, not in each page, so the
// header renders immediately on navigation and the child pages only
// have to worry about their own data (conversations, contacts,
// blocks).

export default async function AgentWorkspaceLayout({
  params,
  children,
}: {
  params: Promise<{ handle: string }>
  children: React.ReactNode
}) {
  const { handle } = await params
  const profile = await apiFetch<AgentProfile>(`/dashboard/agents/${handle}`)

  return (
    <ProfileDrawerProvider>
      <LastAgentTracker handle={handle} />
      <div className="bg-chat-bg flex min-h-0 min-w-0 flex-1 flex-col">
        <ChatHeader profile={profile} />
        {children}
      </div>
      <AgentProfileDrawer />
    </ProfileDrawerProvider>
  )
}
