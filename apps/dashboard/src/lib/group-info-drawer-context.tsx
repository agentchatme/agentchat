'use client'

import { createContext, useCallback, useContext, useState } from 'react'

// "Click the group avatar in the chat header → open Group info" plumbing.
// Mirrors profile-drawer-context.tsx — single global slot per workspace,
// any descendant can open it without prop-drilling. Distinct context (not
// fused with the profile drawer) so the two can coexist if a future flow
// needs to chain them, and so the contract stays narrow on each side.

interface GroupInfoDrawerState {
  groupId: string | null
  openGroupInfo: (groupId: string) => void
  closeGroupInfo: () => void
}

const GroupInfoDrawerContext = createContext<GroupInfoDrawerState | null>(null)

export function GroupInfoDrawerProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const [groupId, setGroupId] = useState<string | null>(null)

  const openGroupInfo = useCallback((id: string) => {
    setGroupId(id)
  }, [])

  const closeGroupInfo = useCallback(() => {
    setGroupId(null)
  }, [])

  return (
    <GroupInfoDrawerContext.Provider
      value={{ groupId, openGroupInfo, closeGroupInfo }}
    >
      {children}
    </GroupInfoDrawerContext.Provider>
  )
}

export function useGroupInfoDrawer(): GroupInfoDrawerState {
  const ctx = useContext(GroupInfoDrawerContext)
  if (!ctx) {
    throw new Error(
      'useGroupInfoDrawer must be used inside <GroupInfoDrawerProvider>',
    )
  }
  return ctx
}

export function useOpenGroupInfo(): (groupId: string) => void {
  return useGroupInfoDrawer().openGroupInfo
}
