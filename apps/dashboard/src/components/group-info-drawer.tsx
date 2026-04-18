'use client'

import { useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { format } from 'date-fns'
import { Camera, Loader2, Trash2, Users } from 'lucide-react'
import { toast } from 'sonner'

import { useGroupInfoDrawer } from '@/lib/group-info-drawer-context'
import type { GroupDetail } from '@/lib/types'
import { avatarColorFor } from '@/lib/avatar-color'
import { useOpenProfile } from '@/lib/profile-drawer-context'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'

// "Group info" drawer — opens from a click on the group avatar/name in
// the chat header (ThreadHeader). Mirrors the WhatsApp / Telegram group
// info sheet: avatar (large, with admin-only edit affordance), name,
// description, member list with roles. Read-only for non-admins; admins
// see a Camera button to upload a new avatar and a Trash button to
// remove the current one.
//
// Mounted once per workspace (see (workspace)/layout.tsx). The drawer
// reads the active owner-agent handle from useParams() so callers don't
// have to thread it through; they pass only the groupId via context.
//
// Server contract: GET /dashboard/agents/:handle/groups/:groupId returns
// the same shape group.service.assembleGroupDetail produces, including
// `your_role` — that field gates every admin affordance below.
//
// Image limits enforced server-side (5 MB, ≥128px on each axis, magic
// byte sniff for jpeg/png/webp/gif). The client doesn't pre-validate;
// errors come back as 400s and surface verbatim in the toast so users
// see the actual reason (e.g. "Avatar must be at least 128px on each
// side") rather than a generic "Upload failed".

const ACCEPT = 'image/jpeg,image/png,image/webp,image/gif'

export function GroupInfoDrawer() {
  const { groupId, closeGroupInfo } = useGroupInfoDrawer()
  const params = useParams<{ handle: string }>()
  const ownerHandle = params?.handle

  const [detail, setDetail] = useState<GroupDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  // Bumped on a successful upload/remove so the drawer refetches without
  // tearing down the dialog. Keeps the modal open with a brand-new avatar
  // visible the moment the server confirms the write — no flicker, no
  // stale image cached in <AvatarImage>.
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    if (!groupId || !ownerHandle) {
      setDetail(null)
      setError(null)
      return
    }
    const controller = new AbortController()
    setIsLoading(true)
    setError(null)
    fetch(
      `/dashboard/agents/${ownerHandle}/groups/${groupId}`,
      { signal: controller.signal, cache: 'no-store' },
    )
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            code?: string
            message?: string
          }
          throw new Error(body.message ?? `Failed to load group (${res.status})`)
        }
        return res.json() as Promise<GroupDetail>
      })
      .then((g) => setDetail(g))
      .catch((e: unknown) => {
        if (e instanceof Error && e.name === 'AbortError') return
        setError(e instanceof Error ? e.message : 'Could not load group info')
      })
      .finally(() => setIsLoading(false))
    return () => controller.abort()
  }, [groupId, ownerHandle, reloadToken])

  const isOpen = groupId !== null

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(next) => {
        if (!next) closeGroupInfo()
      }}
    >
      <DialogContent className="max-w-md gap-0 p-0">
        <DialogTitle className="sr-only">
          {detail?.name ?? 'Group info'}
        </DialogTitle>
        <DialogDescription className="sr-only">
          Group info{detail ? ` for ${detail.name}` : ''}.
        </DialogDescription>
        {isLoading || (!detail && !error) ? (
          <GroupInfoSkeleton />
        ) : error ? (
          <ErrorState message={error} />
        ) : detail && ownerHandle ? (
          <GroupInfoBody
            detail={detail}
            ownerHandle={ownerHandle}
            onChanged={() => setReloadToken((t) => t + 1)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function GroupInfoBody({
  detail,
  ownerHandle,
  onChanged,
}: {
  detail: GroupDetail
  ownerHandle: string
  onChanged: () => void
}) {
  const isAdmin = detail.your_role === 'admin'
  const color = avatarColorFor(detail.id)
  const initial = (detail.name || 'G').charAt(0).toUpperCase()

  return (
    <div className="flex max-h-[80vh] flex-col">
      <div className="flex flex-col items-center gap-4 px-6 pt-8 pb-6 text-center">
        <GroupAvatarBlock
          detail={detail}
          ownerHandle={ownerHandle}
          isAdmin={isAdmin}
          color={color}
          initial={initial}
          onChanged={onChanged}
        />

        <div className="flex flex-col items-center gap-1">
          <h2 className="text-xl leading-tight font-semibold tracking-tight">
            {detail.name}
          </h2>
          <span className="text-muted-foreground text-xs">
            {detail.member_count === 1
              ? '1 member'
              : `${detail.member_count} members`}
          </span>
        </div>

        {detail.description && (
          <p className="text-foreground/80 max-w-[320px] text-sm leading-relaxed">
            {detail.description}
          </p>
        )}

        <div className="text-muted-foreground text-[11px] uppercase tracking-wide">
          Created by @{detail.created_by} ·{' '}
          {format(new Date(detail.created_at), 'MMM yyyy')}
        </div>
      </div>

      <div className="border-t">
        <div className="text-muted-foreground px-6 pt-4 pb-2 text-[11px] font-semibold tracking-wider uppercase">
          Members
        </div>
        <ScrollArea className="max-h-[280px] pb-4">
          <ul className="flex flex-col">
            {detail.members.map((m) => (
              <MemberRow
                key={m.handle}
                handle={m.handle}
                displayName={m.display_name}
                role={m.role}
              />
            ))}
          </ul>
        </ScrollArea>
      </div>
    </div>
  )
}

function GroupAvatarBlock({
  detail,
  ownerHandle,
  isAdmin,
  color,
  initial,
  onChanged,
}: {
  detail: GroupDetail
  ownerHandle: string
  isAdmin: boolean
  color: { fg: string }
  initial: string
  onChanged: () => void
}) {
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [isRemoving, setIsRemoving] = useState(false)
  const busy = isUploading || isRemoving

  const onPick = () => {
    if (busy || !isAdmin) return
    fileRef.current?.click()
  }

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    // Always clear the input so picking the same file twice in a row still
    // fires onChange — the input's value otherwise stays set and the
    // browser suppresses the duplicate event.
    if (e.target) e.target.value = ''
    if (!file) return

    setIsUploading(true)
    try {
      const res = await fetch(
        `/dashboard/agents/${ownerHandle}/groups/${detail.id}/avatar`,
        {
          method: 'PUT',
          // Raw bytes — server sniffs format from magic bytes. The
          // octet-stream header is just a Content-Type that's guaranteed
          // to bypass any client-side multipart parsing surprise; the
          // server doesn't trust it either way.
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file,
        },
      )
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          code?: string
          message?: string
        }
        throw new Error(body.message ?? `Upload failed (${res.status})`)
      }
      toast.success('Group avatar updated')
      onChanged()
      // Refresh the parent route so the conversation list and thread
      // header pick up the new avatar URL on next render.
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setIsUploading(false)
    }
  }

  const onRemove = async () => {
    if (busy || !isAdmin || !detail.avatar_url) return
    setIsRemoving(true)
    try {
      const res = await fetch(
        `/dashboard/agents/${ownerHandle}/groups/${detail.id}/avatar`,
        { method: 'DELETE' },
      )
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          code?: string
          message?: string
        }
        throw new Error(body.message ?? `Remove failed (${res.status})`)
      }
      toast.success('Group avatar removed')
      onChanged()
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Remove failed')
    } finally {
      setIsRemoving(false)
    }
  }

  return (
    <div className="relative">
      <Avatar
        className="bg-muted size-28 shrink-0"
        style={{ color: color.fg }}
      >
        {detail.avatar_url ? (
          <AvatarImage src={detail.avatar_url} alt={detail.name} />
        ) : null}
        <AvatarFallback
          className="bg-transparent"
          style={{ color: color.fg }}
        >
          {detail.name ? (
            <span className="text-4xl font-semibold">{initial}</span>
          ) : (
            <Users className="size-10" />
          )}
        </AvatarFallback>
      </Avatar>

      {isAdmin && (
        <>
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={onFile}
          />
          <Button
            type="button"
            size="icon"
            onClick={onPick}
            disabled={busy}
            aria-label="Change group avatar"
            className="absolute right-0 bottom-0 size-9 rounded-full shadow-md"
          >
            {isUploading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Camera className="size-4" />
            )}
          </Button>
          {detail.avatar_url && (
            <Button
              type="button"
              size="icon"
              variant="secondary"
              onClick={onRemove}
              disabled={busy}
              aria-label="Remove group avatar"
              className="absolute -right-2 -top-2 size-7 rounded-full shadow-md"
            >
              {isRemoving ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Trash2 className="size-3" />
              )}
            </Button>
          )}
        </>
      )}
    </div>
  )
}

function MemberRow({
  handle,
  displayName,
  role,
}: {
  handle: string
  displayName: string | null
  role: 'admin' | 'member'
}) {
  const openProfile = useOpenProfile()
  const color = avatarColorFor(handle)
  const name = displayName ?? `@${handle}`
  const initial = name.replace(/^@/, '').charAt(0).toUpperCase()

  return (
    <li>
      <button
        type="button"
        onClick={() => openProfile(handle)}
        className="hover:bg-accent flex w-full items-center gap-3 px-6 py-2 text-left transition-colors focus-visible:outline-none focus-visible:bg-accent"
      >
        <Avatar
          className="bg-muted size-9 shrink-0"
          style={{ color: color.fg }}
        >
          <AvatarFallback
            className="bg-transparent text-sm font-semibold"
            style={{ color: color.fg }}
          >
            {initial}
          </AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">
            {displayName ?? `@${handle}`}
          </span>
          {displayName && (
            <span className="text-muted-foreground truncate text-xs">
              @{handle}
            </span>
          )}
        </div>
        {role === 'admin' && (
          <Badge variant="secondary" className="shrink-0 text-[10px]">
            Admin
          </Badge>
        )}
      </button>
    </li>
  )
}

function GroupInfoSkeleton() {
  return (
    <div className="flex flex-col items-center gap-4 px-6 pt-8 pb-6">
      <Skeleton className="size-28 rounded-full" />
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-4 w-24" />
      <div className="w-full pt-4">
        <Skeleton className="h-4 w-20" />
        <div className="mt-3 flex flex-col gap-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      </div>
    </div>
  )
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="text-muted-foreground flex flex-col items-center gap-2 px-6 py-10 text-center text-sm">
      <p>{message}</p>
    </div>
  )
}
