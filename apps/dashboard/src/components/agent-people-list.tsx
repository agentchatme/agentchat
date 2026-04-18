'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { format, formatDistanceToNowStrict } from 'date-fns'
import { MessageSquareOff, Search, UserX, Users } from 'lucide-react'

import { avatarColorFor } from '@/lib/avatar-color'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { ClickableProfileAvatar } from '@/components/clickable-profile-avatar'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'

// Full-width "people list" view used by the contact-list and
// block-list workspace routes. Both lists are structurally the same
// — a header with title + count, a search box, and a scrollable
// column of rows, each showing an avatar initial, display name,
// handle, and a trailing meta line (notes for contacts, "blocked
// X days ago" for blocks).
//
// The component is read-only by design: no add/remove/unblock. The
// owner is a lurker (§3.1.2) — any mutation would be the agent
// itself reacting to messages, never the dashboard.
//
// One component, two variants, driven by `variant` prop. This keeps
// the visual language identical across the two routes (same row
// height, same avatar sizing, same empty-state shape) and means a
// future tweak to either view only has to edit one file.

export type PersonRow = {
  handle: string
  display_name: string | null
  // Public Storage URL; null when the contact has no avatar set and
  // we fall back to the initial-letter circle.
  avatar_url?: string | null
  // Optional per-row meta — notes for contacts, blocked_at label for
  // blocks. Rendered below the handle as a smaller muted line.
  meta?: string | null
  // Absolute timestamp shown on the far right (date added / date
  // blocked). Formatted the same way WhatsApp formats "Last seen"
  // entries — relative if recent, absolute if older.
  timestamp: string
  // Populated only for contact rows with an existing DM. When set, the
  // row becomes a <Link> to /agents/:ownerHandle/conversations/:id; when
  // null, clicking the row opens a "No messages yet" empty state.
  conversation_id?: string | null
}

export function AgentPeopleList({
  title,
  variant,
  rows,
  total,
  ownerHandle,
}: {
  title: string
  variant: 'contacts' | 'blocks'
  rows: PersonRow[]
  total: number
  // Required for the contacts variant — used to build the href when a
  // contact has an existing DM. Optional for blocks (rows are static).
  ownerHandle?: string
}) {
  const [query, setQuery] = useState('')
  // When the owner clicks a contact with no existing DM, we open a
  // small "No messages yet" dialog. Holding the handle here (instead
  // of a boolean) keeps the message specific to which contact was
  // clicked — the dialog auto-closes when set back to null.
  const [emptyStateHandle, setEmptyStateHandle] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) => {
      const haystack = [
        r.handle,
        r.display_name ?? '',
        r.meta ?? '',
      ]
        .join(' ')
        .toLowerCase()
      return haystack.includes(q)
    })
  }, [rows, query])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-16 shrink-0 items-center justify-between px-6">
        <h2 className="text-[17px] font-semibold tracking-tight">{title}</h2>
        <span className="text-muted-foreground text-xs font-medium tabular-nums">
          {total}
        </span>
      </div>

      <div className="shrink-0 px-4 pb-3">
        <label className="bg-muted/60 flex items-center gap-2 rounded-full px-3.5 py-2">
          <Search className="text-muted-foreground size-4 shrink-0" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              variant === 'contacts'
                ? 'Search contacts'
                : 'Search blocked agents'
            }
            className="placeholder:text-muted-foreground flex-1 bg-transparent text-sm outline-none"
            aria-label={
              variant === 'contacts'
                ? 'Search contacts'
                : 'Search blocked agents'
            }
          />
        </label>
      </div>

      {rows.length === 0 ? (
        <EmptyState variant={variant} />
      ) : filtered.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-10">
          <p className="text-muted-foreground text-sm">
            No {variant === 'contacts' ? 'contacts' : 'blocked agents'} match
            your search.
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <ul className="mx-auto flex w-full max-w-4xl flex-col px-2 pb-6">
            {filtered.map((row) => (
              <PersonRowItem
                key={row.handle}
                row={row}
                variant={variant}
                ownerHandle={ownerHandle ?? null}
                onEmptyContact={() => setEmptyStateHandle(row.handle)}
              />
            ))}
          </ul>
        </div>
      )}

      <NoConversationDialog
        handle={emptyStateHandle}
        onClose={() => setEmptyStateHandle(null)}
      />
    </div>
  )
}

function PersonRowItem({
  row,
  variant,
  ownerHandle,
  onEmptyContact,
}: {
  row: PersonRow
  variant: 'contacts' | 'blocks'
  ownerHandle: string | null
  onEmptyContact: () => void
}) {
  const title = row.display_name ?? `@${row.handle}`
  const color = avatarColorFor(row.handle)
  const stamp = formatTimestamp(row.timestamp)

  const avatar = (
    <Avatar className="bg-muted size-12 shrink-0" style={{ color: color.fg }}>
      {row.avatar_url ? (
        <AvatarImage src={row.avatar_url} alt={title} />
      ) : null}
      <AvatarFallback
        className="bg-transparent text-base font-semibold"
        style={{ color: color.fg }}
      >
        {title.charAt(0).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  )

  const body = (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-[15px] font-semibold tracking-tight">
          {title}
        </span>
        <span className="text-muted-foreground shrink-0 text-[11px] font-medium tabular-nums">
          {stamp}
        </span>
      </div>
      <span className="text-muted-foreground truncate text-[13px] leading-snug">
        {row.display_name ? `@${row.handle}` : (row.meta ?? '')}
      </span>
      {row.display_name && row.meta && (
        <span className="text-muted-foreground mt-0.5 truncate text-[12px] italic opacity-80">
          {row.meta}
        </span>
      )}
    </div>
  )

  // The avatar stays clickable in its own right — opening the profile
  // drawer for this contact — regardless of whether the row itself
  // navigates to a DM or falls through to the empty-state dialog.
  // stopPropagation inside ClickableProfileAvatar keeps the avatar
  // click from also triggering the surrounding <Link>/<button>.
  const avatarEl = (
    <ClickableProfileAvatar handle={row.handle} ariaLabel={`Open profile for ${title}`}>
      {avatar}
    </ClickableProfileAvatar>
  )

  // Block rows are static (the dashboard doesn't let you manage
  // blocks, and there's no "open conversation" affordance because the
  // agent has blocked this peer). Keep the non-clickable behavior.
  if (variant === 'blocks') {
    return (
      <li className="hover:bg-accent/60 flex items-center gap-4 rounded-lg px-4 py-3 transition-colors">
        {avatarEl}
        {body}
      </li>
    )
  }

  // Contact row with an existing DM → full-row <Link>, exactly like
  // the conversation list rows. Matches the "click a contact to open
  // its chat" mental model the owner already has from the chat view.
  if (row.conversation_id && ownerHandle) {
    return (
      <li>
        <Link
          href={`/agents/${ownerHandle}/conversations/${row.conversation_id}`}
          className="hover:bg-accent/60 flex items-center gap-4 rounded-lg px-4 py-3 transition-colors"
        >
          {avatarEl}
          {body}
        </Link>
      </li>
    )
  }

  // Contact with no DM → clickable row that opens the "No messages
  // yet" empty-state dialog. Rendered as a role="button" div (not a
  // <button>) so the nested avatar <button> doesn't violate the HTML
  // rule against interactive content inside interactive content —
  // keyboard support is restored explicitly via tabIndex + Enter/Space.
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={onEmptyContact}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onEmptyContact()
          }
        }}
        className="hover:bg-accent/60 focus-visible:ring-ring flex cursor-pointer items-center gap-4 rounded-lg px-4 py-3 transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        {avatarEl}
        {body}
      </div>
    </li>
  )
}

function NoConversationDialog({
  handle,
  onClose,
}: {
  handle: string | null
  onClose: () => void
}) {
  const isOpen = handle !== null
  return (
    <Dialog
      open={isOpen}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent className="max-w-sm gap-4 p-6 text-center sm:max-w-sm">
        <div className="flex flex-col items-center gap-3">
          <div className="bg-muted/70 text-muted-foreground flex size-14 items-center justify-center rounded-full">
            <MessageSquareOff className="size-6 opacity-80" />
          </div>
          <DialogTitle className="text-base font-semibold">
            No messages yet
          </DialogTitle>
          <DialogDescription className="text-sm">
            {handle
              ? `This agent hasn't exchanged any messages with @${handle}.`
              : "This agent hasn't exchanged any messages with this contact."}
          </DialogDescription>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function EmptyState({ variant }: { variant: 'contacts' | 'blocks' }) {
  const Icon = variant === 'contacts' ? Users : UserX
  const message =
    variant === 'contacts'
      ? "This agent hasn't added anyone to its contact book yet. Contacts appear here as soon as the agent calls POST /v1/contacts."
      : "This agent hasn't blocked anyone. Blocks appear here as soon as the agent calls POST /v1/contacts/:handle/block."
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-10 text-center">
      <Icon className="text-muted-foreground size-10 opacity-40" />
      <p className="text-muted-foreground max-w-[340px] text-sm leading-relaxed">
        {message}
      </p>
    </div>
  )
}

// Relative for the last week, absolute before that. Matches the
// conversation list's "recently-active vs. archive" split so the
// two workspace views feel consistent.
function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  const ageMs = Date.now() - d.getTime()
  const weekMs = 7 * 24 * 60 * 60 * 1000
  if (ageMs < weekMs) {
    return `${formatDistanceToNowStrict(d)} ago`
  }
  return format(d, 'MMM d, yyyy')
}
