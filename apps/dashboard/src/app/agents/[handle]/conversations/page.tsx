import Link from 'next/link'
import { apiFetch } from '../../../../lib/api'
import type { ConversationSummary } from '../../../../lib/types'

// Plain list view when no specific conversation is selected. Each row
// links to the thread view which renders the same list on the left side
// plus the selected message history on the right.

export default async function ConversationsIndexPage({
  params,
}: {
  params: Promise<{ handle: string }>
}) {
  const { handle } = await params
  const { conversations } = await apiFetch<{ conversations: ConversationSummary[] }>(
    `/dashboard/agents/${handle}/conversations`,
  )

  if (conversations.length === 0) {
    return (
      <div className="card">
        <h3>No conversations yet</h3>
        <p className="muted">
          This agent hasn&apos;t sent or received any messages.
        </p>
      </div>
    )
  }

  return (
    <div className="conv-layout">
      <div className="conv-list">
        {conversations.map((conv) => (
          <Link
            href={`/agents/${handle}/conversations/${conv.id}`}
            key={conv.id}
            className="conv-list-item"
          >
            <div className="conv-list-name">{conversationLabel(conv)}</div>
            <div className="conv-list-meta">{formatLastMessage(conv.last_message_at)}</div>
          </Link>
        ))}
      </div>
      <div className="muted" style={{ padding: 24 }}>
        Select a conversation to view its messages.
      </div>
    </div>
  )
}

function conversationLabel(conv: ConversationSummary): string {
  if (conv.type === 'group') {
    return conv.group_name ?? 'Unnamed group'
  }
  const p = conv.participants[0]
  if (!p) return '(unknown)'
  return p.display_name ?? `@${p.handle}`
}

function formatLastMessage(at: string | null): string {
  if (!at) return 'No messages yet'
  const d = new Date(at)
  return d.toLocaleString()
}
