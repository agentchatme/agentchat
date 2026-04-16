'use client'

import { useMemo, useState } from 'react'
import { format, formatDistanceToNowStrict } from 'date-fns'
import { Search, UserX, Users } from 'lucide-react'

import { avatarColorFor } from '@/lib/avatar-color'

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
  // Optional per-row meta — notes for contacts, blocked_at label for
  // blocks. Rendered below the handle as a smaller muted line.
  meta?: string | null
  // Absolute timestamp shown on the far right (date added / date
  // blocked). Formatted the same way WhatsApp formats "Last seen"
  // entries — relative if recent, absolute if older.
  timestamp: string
}

export function AgentPeopleList({
  title,
  variant,
  rows,
  total,
}: {
  title: string
  variant: 'contacts' | 'blocks'
  rows: PersonRow[]
  total: number
}) {
  const [query, setQuery] = useState('')

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
              <PersonRowItem key={row.handle} row={row} />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function PersonRowItem({ row }: { row: PersonRow }) {
  const title = row.display_name ?? `@${row.handle}`
  const color = avatarColorFor(row.handle)
  const stamp = formatTimestamp(row.timestamp)

  return (
    <li className="hover:bg-accent/60 flex items-center gap-4 rounded-lg px-4 py-3 transition-colors">
      <div
        className="bg-muted flex size-12 shrink-0 items-center justify-center rounded-full"
        style={{ color: color.fg }}
      >
        <span className="text-base font-semibold">
          {title.charAt(0).toUpperCase()}
        </span>
      </div>
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
    </li>
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
