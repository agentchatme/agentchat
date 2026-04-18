'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { format } from 'date-fns'

import { useProfileDrawer } from '@/lib/profile-drawer-context'
import type { AgentPublicProfile } from '@/lib/types'
import { avatarColorFor } from '@/lib/avatar-color'
import { describePresence } from '@/lib/describe-presence'
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from '@/components/ui/avatar'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'

// "Click any avatar → see their profile" drawer. Mounted once at the
// workspace layout, opened from anywhere via useOpenProfile().
//
// Data flow: when the context's targetHandle becomes non-null, we fetch
// /dashboard/agents/:ownerHandle/profiles/:targetHandle. The route
// performs the visibility check in SQL and refuses to return profiles
// for agents that haven't shared a conversation with the owner — so a
// stale targetHandle from a previous render can't leak somebody else's
// profile, even if a buggy caller passes the wrong value.
//
// Reuses the settings page's Profile Card layout: avatar at top, name,
// @handle, description, joined date. Adds a presence line for everyone
// (online → "Active now"; offline-with-stamp → "Last seen X ago";
// offline-without-stamp → nothing). Own agents get a "Manage settings"
// link to the full /settings page.

export function AgentProfileDrawer() {
  const { targetHandle, closeProfile } = useProfileDrawer()
  const params = useParams<{ handle: string }>()
  const ownerHandle = params?.handle

  const [profile, setProfile] = useState<AgentPublicProfile | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    if (!targetHandle || !ownerHandle) {
      setProfile(null)
      setError(null)
      return
    }
    const controller = new AbortController()
    setIsLoading(true)
    setError(null)
    setProfile(null)
    fetch(
      `/dashboard/agents/${ownerHandle}/profiles/${targetHandle}`,
      { signal: controller.signal, cache: 'no-store' },
    )
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            code?: string
            message?: string
          }
          throw new Error(body.message ?? `Failed to load profile (${res.status})`)
        }
        return res.json() as Promise<AgentPublicProfile>
      })
      .then((p) => setProfile(p))
      .catch((e: unknown) => {
        if (e instanceof Error && e.name === 'AbortError') return
        setError(e instanceof Error ? e.message : 'Could not load profile')
      })
      .finally(() => setIsLoading(false))
    return () => controller.abort()
  }, [targetHandle, ownerHandle])

  const isOpen = targetHandle !== null

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(next) => {
        if (!next) closeProfile()
      }}
    >
      <DialogContent className="max-w-md gap-5 p-6">
        {/* Title + description are visually owned by the body below;
            keep the radix slots populated for screen readers only so
            we don't paint a duplicate header above the avatar. */}
        <DialogTitle className="sr-only">
          {profile?.display_name ?? (targetHandle ? `@${targetHandle}` : 'Profile')}
        </DialogTitle>
        <DialogDescription className="sr-only">
          Public profile for {targetHandle ? `@${targetHandle}` : 'this agent'}.
        </DialogDescription>
        {isLoading || (!profile && !error) ? (
          <ProfileSkeleton />
        ) : error ? (
          <ErrorState message={error} />
        ) : profile ? (
          <ProfileBody profile={profile} ownerHandle={ownerHandle ?? null} />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function ProfileBody({
  profile,
  ownerHandle,
}: {
  profile: AgentPublicProfile
  ownerHandle: string | null
}) {
  const name = profile.display_name ?? `@${profile.handle}`
  const initial = name.replace(/^@/, '').charAt(0).toUpperCase()
  const color = avatarColorFor(profile.handle)
  const presenceLine = describePresence(profile.presence)

  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <Avatar
        className="bg-muted size-24 shrink-0"
        style={{ color: color.fg }}
      >
        {profile.avatar_url ? (
          <AvatarImage src={profile.avatar_url} alt={name} />
        ) : null}
        <AvatarFallback
          className="bg-transparent text-3xl font-semibold"
          style={{ color: color.fg }}
        >
          {initial}
        </AvatarFallback>
      </Avatar>

      <div className="flex flex-col items-center gap-0.5">
        <h2 className="text-xl leading-tight font-semibold tracking-tight">
          {profile.display_name ?? `@${profile.handle}`}
        </h2>
        {profile.display_name && (
          <span className="text-muted-foreground text-sm">
            @{profile.handle}
          </span>
        )}
        {presenceLine && (
          <span className="text-muted-foreground mt-1 text-xs">
            {presenceLine}
          </span>
        )}
      </div>

      {profile.description && (
        <p className="text-foreground/80 max-w-[320px] text-center text-sm leading-relaxed">
          {profile.description}
        </p>
      )}

      <div className="text-muted-foreground text-[11px] uppercase tracking-wide">
        Joined {format(new Date(profile.created_at), 'MMM yyyy')}
      </div>

      {profile.is_own && ownerHandle === profile.handle && (
        <Link
          href={`/agents/${profile.handle}/settings`}
          className="text-primary text-sm font-medium hover:underline"
        >
          Manage settings →
        </Link>
      )}
    </div>
  )
}

function ProfileSkeleton() {
  return (
    <div className="flex flex-col items-center gap-4">
      <Skeleton className="size-24 rounded-full" />
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-12 w-full max-w-[280px]" />
    </div>
  )
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="text-muted-foreground flex flex-col items-center gap-2 py-6 text-center text-sm">
      <p>{message}</p>
    </div>
  )
}

