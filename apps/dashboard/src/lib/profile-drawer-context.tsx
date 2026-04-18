'use client'

import { createContext, useCallback, useContext, useState } from 'react'

// Global "click any avatar → see their profile" plumbing. The drawer
// itself lives once per workspace at the workspace layout, so any
// descendant can call useOpenProfile(handle) without prop-drilling.
//
// We deliberately keep ONLY the target handle in context — the active
// owner-agent handle is read from the URL inside the drawer via
// useParams(), so the context surface stays minimal and works the same
// from chat / contacts / blocks / settings without each caller having
// to thread the owner handle through.

interface ProfileDrawerState {
  targetHandle: string | null
  openProfile: (handle: string) => void
  closeProfile: () => void
}

const ProfileDrawerContext = createContext<ProfileDrawerState | null>(null)

export function ProfileDrawerProvider({ children }: { children: React.ReactNode }) {
  const [targetHandle, setTargetHandle] = useState<string | null>(null)

  const openProfile = useCallback((handle: string) => {
    setTargetHandle(handle.replace(/^@/, '').toLowerCase())
  }, [])

  const closeProfile = useCallback(() => {
    setTargetHandle(null)
  }, [])

  return (
    <ProfileDrawerContext.Provider
      value={{ targetHandle, openProfile, closeProfile }}
    >
      {children}
    </ProfileDrawerContext.Provider>
  )
}

export function useProfileDrawer(): ProfileDrawerState {
  const ctx = useContext(ProfileDrawerContext)
  if (!ctx) {
    throw new Error(
      'useProfileDrawer must be used inside <ProfileDrawerProvider>',
    )
  }
  return ctx
}

export function useOpenProfile(): (handle: string) => void {
  return useProfileDrawer().openProfile
}
