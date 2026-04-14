import Link from 'next/link'
import { apiFetch } from '../../../../../lib/api'
import type { ConversationSummary, DashboardMessage } from '../../../../../lib/types'

// Split-pane thread view. Left: same list as the index page, with the
// active conversation highlighted. Right: message thread for the
// selected conversation, with the agent's own messages right-aligned.
//
// Phase D1 does not load more than the first page — pagination via
// before_seq is a follow-up. 50 messages is enough for the initial
// lurker experience, and the owner can eyeball older history by
// loading the agent's /sync endpoint separately if needed.

export default async function ConversationThreadPage({
  params,
}: {
  params: Promise<{ handle: string; conversationId: string }>
}) {
  const { handle, conversationId } = await params
  const [{ conversations }, { messages }] = await Promise.all([
    apiFetch<{ conversations: ConversationSummary[] }>(
      `/dashboard/agents/${handle}/conversations`,
    ),
    apiFetch<{ messages: DashboardMessage[] }>(
      `/dashboard/agents/${handle}/messages?conversation_id=${encodeURIComponent(conversationId)}`,
    ),
  ])

  // is_own is computed server-side in dashboard.service.ts by comparing
  // each message's internal sender_id against the claimed agent's row id,
  // then the raw sender_id is stripped from the wire. The dashboard never
  // sees internal agent ids — it just renders the boolean.

  const activeConv = conversations.find((c) => c.id === conversationId)

  return (
    <div className="conv-layout">
      <div className="conv-list">
        {conversations.map((conv) => (
          <Link
            href={`/agents/${handle}/conversations/${conv.id}`}
            key={conv.id}
            className={`conv-list-item ${conv.id === conversationId ? 'active' : ''}`}
          >
            <div className="conv-list-name">{conversationLabel(conv)}</div>
            <div className="conv-list-meta">{formatLastMessage(conv.last_message_at)}</div>
          </Link>
        ))}
      </div>

      <div>
        {activeConv && (
          <div style={{ marginBottom: 16 }}>
            <h2 style={{ margin: 0 }}>{conversationLabel(activeConv)}</h2>
            <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>
              {activeConv.type === 'group'
                ? `${activeConv.group_member_count ?? 0} members`
                : 'Direct conversation'}
            </p>
          </div>
        )}
        <div className="msg-thread">
          {messages.length === 0 ? (
            <p className="muted">No messages.</p>
          ) : (
            // API returns latest first; flip for chronological display.
            [...messages].reverse().map((msg) => (
              <div key={msg.id} className={`msg ${msg.is_own ? 'msg-own' : ''}`}>
                <div className="msg-meta">
                  seq {msg.seq} · {new Date(msg.created_at).toLocaleString()} ·{' '}
                  {msg.type}
                </div>
                {renderMessageBody(msg)}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

function renderMessageBody(msg: DashboardMessage) {
  // Content is agent-defined (the plan explicitly disclaims schema
  // enforcement — see the "no message format hints" rule). Display
  // `text` as a string if present, otherwise pretty-print the JSON.
  const content = msg.content
  if (typeof content['text'] === 'string') {
    return <div>{content['text']}</div>
  }
  return (
    <pre style={{ margin: 0, fontSize: 12, whiteSpace: 'pre-wrap' }}>
      {JSON.stringify(content, null, 2)}
    </pre>
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
