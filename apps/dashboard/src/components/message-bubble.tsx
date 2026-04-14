import { format } from 'date-fns'

import type { DashboardMessage } from '@/lib/types'
import { cn } from '@/lib/utils'

// One message bubble, iMessage-style: outgoing hugs the right edge
// with the "outgoing" token, incoming hugs the left with the
// "incoming" token. Both tokens live under --chat-* and are scoped to
// the chat panel, so the messenger coloring never bleeds into the
// rest of the admin chrome.
//
// AgentChat is a transport — the platform never looks inside
// MessageContent to render fancy cards, per the "no message format
// hints" rule (§3.1 / feedback memo). So the bubble only renders a
// string body field if one happens to be present, otherwise it shows
// the type label plus a <pre> fallback with the JSON. That keeps
// unknown message types auditable without pretending we know what
// they mean.

type BodyShape = { body?: unknown; text?: unknown }

function extractText(content: Record<string, unknown>): string | null {
  const c = content as BodyShape
  if (typeof c.body === 'string') return c.body
  if (typeof c.text === 'string') return c.text
  return null
}

export function MessageBubble({ message }: { message: DashboardMessage }) {
  const text = extractText(message.content)
  const stamp = format(new Date(message.created_at), 'HH:mm')
  const isOwn = message.is_own

  return (
    <div
      className={cn(
        'flex w-full',
        isOwn ? 'justify-end' : 'justify-start',
      )}
    >
      <div
        className={cn(
          'flex max-w-[75%] flex-col gap-1 rounded-2xl px-3 py-2',
          isOwn
            ? 'bg-chat-outgoing-bg text-chat-outgoing-fg rounded-br-sm'
            : 'bg-chat-incoming-bg text-chat-incoming-fg rounded-bl-sm',
        )}
      >
        {text !== null ? (
          <p className="text-sm whitespace-pre-wrap break-words">{text}</p>
        ) : (
          <div className="space-y-1">
            <p className="text-[10px] uppercase opacity-70">{message.type}</p>
            <pre className="bg-background/20 max-w-full overflow-x-auto rounded-md p-2 text-[11px] leading-snug">
              {JSON.stringify(message.content, null, 2)}
            </pre>
          </div>
        )}
        <span
          className={cn(
            'text-[10px] tabular-nums',
            isOwn ? 'self-end opacity-80' : 'text-chat-meta',
          )}
        >
          {stamp}
        </span>
      </div>
    </div>
  )
}
