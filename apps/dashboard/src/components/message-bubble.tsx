import { format } from 'date-fns'

import type { DashboardMessage } from '@/lib/types'
import { cn } from '@/lib/utils'

// One message bubble, WhatsApp-style: outgoing hugs the right edge
// with the "outgoing" token, incoming hugs the left with the
// "incoming" token. Both tokens live under --chat-* and are scoped
// to the chat panel, so the messenger coloring never bleeds into
// the rest of the admin chrome.
//
// Consecutive-grouping: when the previous message is from the same
// sender and within a short window, the tail corner is flattened
// and the vertical gap is tightened so a burst of messages reads
// as one cluster — the same thing WhatsApp / iMessage do.
//
// AgentChat is a transport — the platform never looks inside
// MessageContent to render fancy cards, per the "no message format
// hints" rule (§4.6). So the bubble only renders a string body
// field if one happens to be present, otherwise it shows the type
// label plus a <pre> fallback with the JSON. That keeps unknown
// message types auditable without pretending we know what they
// mean.

type BodyShape = { body?: unknown; text?: unknown }

function extractText(content: Record<string, unknown>): string | null {
  const c = content as BodyShape
  if (typeof c.body === 'string') return c.body
  if (typeof c.text === 'string') return c.text
  return null
}

export function MessageBubble({
  message,
  groupedWithPrev,
  groupedWithNext,
}: {
  message: DashboardMessage
  groupedWithPrev: boolean
  groupedWithNext: boolean
}) {
  const text = extractText(message.content)
  const stamp = format(new Date(message.created_at), 'HH:mm')
  const isOwn = message.is_own

  return (
    <div
      className={cn(
        'flex w-full',
        isOwn ? 'justify-end' : 'justify-start',
        groupedWithPrev ? 'mt-0.5' : 'mt-2',
      )}
    >
      <div
        className={cn(
          'flex max-w-[78%] flex-col gap-1 rounded-2xl px-3.5 py-2 shadow-sm',
          isOwn
            ? 'bg-chat-outgoing-bg text-chat-outgoing-fg'
            : 'bg-chat-incoming-bg text-chat-incoming-fg',
          isOwn && !groupedWithNext && 'rounded-br-md',
          !isOwn && !groupedWithNext && 'rounded-bl-md',
        )}
      >
        {text !== null ? (
          <p className="text-[14.5px] leading-[1.4] whitespace-pre-wrap break-words">
            {text}
          </p>
        ) : (
          <div className="space-y-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-wider opacity-70">
              {message.type}
            </p>
            <pre className="bg-background/25 max-w-full overflow-x-auto rounded-md p-2.5 text-xs leading-snug">
              {JSON.stringify(message.content, null, 2)}
            </pre>
          </div>
        )}
        <span
          className={cn(
            '-mt-0.5 self-end text-[10.5px] font-medium tabular-nums',
            isOwn ? 'opacity-75' : 'text-chat-meta',
          )}
        >
          {stamp}
        </span>
      </div>
    </div>
  )
}
