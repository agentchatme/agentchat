import { getSupabaseClient } from '../client.js'

/**
 * Atomic idempotent message insert. Calls the SQL function
 * send_message_atomic which:
 *   1. Fast-paths on (sender_id, client_msg_id) — returns the existing row
 *      with is_replay=true if this exact send has already happened.
 *   2. Atomically bumps conversations.next_seq and assigns the message seq.
 *   3. Fans out delivery envelopes (message_deliveries) for every non-sender
 *      participant in the same transaction as the message insert.
 *   4. Recovers from the concurrent-insert race via a unique_violation catch.
 *
 * Return value includes `is_replay` so the route can map to 200 (replay) vs
 * 201 (new) and callers can skip the push fan-out on replays.
 *
 * Delivery status (stored/delivered/read) lives on message_deliveries rows,
 * not on the returned message, so callers that need per-recipient state
 * must query message_deliveries separately.
 */
export async function atomicSendMessage(params: {
  id: string
  conversation_id: string
  sender_id: string
  client_msg_id: string
  type: string
  content: Record<string, unknown>
  metadata?: Record<string, unknown>
}) {
  const { data, error } = await getSupabaseClient().rpc('send_message_atomic', {
    p_message_id: params.id,
    p_conversation_id: params.conversation_id,
    p_sender_id: params.sender_id,
    p_client_msg_id: params.client_msg_id,
    p_type: params.type,
    p_content: params.content,
    p_metadata: params.metadata ?? {},
  })

  if (error) throw error

  const row = Array.isArray(data) ? data[0] : data
  if (!row) throw new Error('send_message_atomic returned no row')
  return row as {
    id: string
    conversation_id: string
    sender_id: string
    client_msg_id: string
    seq: number
    type: string
    content: Record<string, unknown>
    metadata: Record<string, unknown>
    created_at: string
    is_replay: boolean
  }
}

/**
 * Fetch a conversation's messages ordered by seq DESC (latest first).
 * Composes per-message delivery state from the single delivery row that
 * exists per message in direct conversations (the non-sender's envelope).
 *
 * When group conversations arrive this will need a caller-scoped join so each
 * side sees only their own envelope, but for 1:1 there's exactly one row per
 * message and both sides converge on it.
 */
export async function getConversationMessages(
  conversationId: string,
  limit = 50,
  beforeSeq?: number,
) {
  let query = getSupabaseClient()
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('seq', { ascending: false })
    .limit(limit)

  if (beforeSeq !== undefined) {
    query = query.lt('seq', beforeSeq)
  }

  const { data: messages, error } = await query
  if (error) throw error
  if (!messages || messages.length === 0) return []

  const deliveries = await fetchDeliveries(messages.map((m) => m.id as string))
  return messages.map((m) => composeWithDelivery(m, deliveries.get(m.id as string)))
}

export async function getMessageById(messageId: string) {
  const { data, error } = await getSupabaseClient()
    .from('messages')
    .select('*')
    .eq('id', messageId)
    .maybeSingle()

  if (error) throw error
  return data
}

// Status lifecycle is forward-only: stored → delivered → read. Both the
// WHERE-in guard below and the message_deliveries BEFORE UPDATE trigger
// enforce this — the guard returns "no change" cheaply, the trigger is a DB
// backstop against late retries.
const STATUS_RANK: Record<string, number> = { stored: 0, delivered: 1, read: 2 }

/**
 * Forward-only update of a single delivery envelope. No-op (returns the
 * existing row) if current status is already at or beyond the target.
 * Returns null if the delivery row doesn't exist at all — meaning the agent
 * is not a recipient of this message, or the message id is invalid.
 */
export async function updateDeliveryStatus(
  messageId: string,
  recipientAgentId: string,
  status: 'delivered' | 'read',
) {
  const updates: Record<string, unknown> = { status }
  if (status === 'delivered') {
    updates.delivered_at = new Date().toISOString()
  } else if (status === 'read') {
    updates.read_at = new Date().toISOString()
  }

  const allowedPrevious = Object.entries(STATUS_RANK)
    .filter(([, rank]) => rank < STATUS_RANK[status]!)
    .map(([name]) => name)

  const { data, error } = await getSupabaseClient()
    .from('message_deliveries')
    .update(updates)
    .eq('message_id', messageId)
    .eq('recipient_agent_id', recipientAgentId)
    .in('status', allowedPrevious)
    .select()
    .maybeSingle()

  if (error) throw error
  if (data) return data as DeliveryRow

  // No rows matched — either row doesn't exist, or status is already >= target.
  const { data: existing, error: fetchError } = await getSupabaseClient()
    .from('message_deliveries')
    .select()
    .eq('message_id', messageId)
    .eq('recipient_agent_id', recipientAgentId)
    .maybeSingle()

  if (fetchError) throw fetchError
  return (existing as DeliveryRow | null) ?? null
}

const DELIVERY_ID_PATTERN = /^del_[a-f0-9]{32}$/

/**
 * Return still-pending (status='stored') deliveries for an agent, oldest
 * first. When `afterDeliveryId` is provided, only rows strictly after that
 * cursor are returned — enabling explicit-ack pagination without prematurely
 * marking anything delivered.
 *
 * Cursor is resolved via a two-phase lookup: fetch the cursor row's
 * (created_at, id), then filter with a composite `(created_at, id) >
 * (cursor.created_at, cursor.id)`. We need the id tiebreaker because
 * created_at has microsecond precision and ties are technically possible
 * under concurrent fan-out.
 *
 * If the cursor is malformed or references an unknown row, we return an
 * empty array rather than silently restarting from the beginning — a bad
 * cursor usually means client-side bookkeeping drift, and restarting would
 * replay messages the client has already processed.
 */
export async function getUndeliveredMessages(
  agentId: string,
  limit = 200,
  afterDeliveryId?: string,
) {
  let afterCreatedAt: string | null = null
  let afterId: string | null = null

  if (afterDeliveryId) {
    if (!DELIVERY_ID_PATTERN.test(afterDeliveryId)) return []

    const { data: cursor, error: cursorErr } = await getSupabaseClient()
      .from('message_deliveries')
      .select('id, created_at')
      .eq('id', afterDeliveryId)
      .eq('recipient_agent_id', agentId)
      .maybeSingle()
    if (cursorErr) throw cursorErr
    if (!cursor) return []

    afterCreatedAt = cursor.created_at as string
    afterId = cursor.id as string
  }

  let query = getSupabaseClient()
    .from('message_deliveries')
    .select('*')
    .eq('recipient_agent_id', agentId)
    .eq('status', 'stored')
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(limit)

  if (afterCreatedAt && afterId) {
    query = query.or(
      `created_at.gt.${afterCreatedAt},and(created_at.eq.${afterCreatedAt},id.gt.${afterId})`,
    )
  }

  const { data: deliveries, error } = await query
  if (error) throw error
  if (!deliveries || deliveries.length === 0) return []

  const messageIds = deliveries.map((d) => d.message_id as string)
  const { data: messages, error: msgError } = await getSupabaseClient()
    .from('messages')
    .select('*')
    .in('id', messageIds)

  if (msgError) throw msgError
  if (!messages) return []

  const mmap = new Map(messages.map((m) => [m.id as string, m]))
  return deliveries
    .filter((d) => mmap.has(d.message_id as string))
    .map((d) => composeWithDelivery(mmap.get(d.message_id as string)!, d as DeliveryRow))
}

/**
 * Mark all 'stored' deliveries for `agentId` at-or-before the given delivery
 * cursor as 'delivered'. Used by POST /v1/messages/sync/ack so a client can
 * explicitly commit a batch after it's been processed — safer than marking
 * delivered on read, because partial-failure during client processing won't
 * silently discard messages.
 *
 * Only operates on rows owned by the caller (recipient_agent_id = agentId),
 * so a guessed cursor can't ack someone else's envelopes.
 *
 * Returns the number of rows updated, 0 if the cursor is malformed / unknown
 * / not owned by the caller.
 */
export async function ackDeliveries(
  agentId: string,
  lastDeliveryId: string,
): Promise<number> {
  if (!DELIVERY_ID_PATTERN.test(lastDeliveryId)) return 0

  const { data: cursor, error: cursorErr } = await getSupabaseClient()
    .from('message_deliveries')
    .select('id, created_at')
    .eq('id', lastDeliveryId)
    .eq('recipient_agent_id', agentId)
    .maybeSingle()
  if (cursorErr) throw cursorErr
  if (!cursor) return 0

  const cursorCreatedAt = cursor.created_at as string
  const cursorId = cursor.id as string
  const deliveredAt = new Date().toISOString()

  const { data, error } = await getSupabaseClient()
    .from('message_deliveries')
    .update({ status: 'delivered', delivered_at: deliveredAt })
    .eq('recipient_agent_id', agentId)
    .eq('status', 'stored')
    .or(
      `created_at.lt.${cursorCreatedAt},and(created_at.eq.${cursorCreatedAt},id.lte.${cursorId})`,
    )
    .select('id')

  if (error) throw error
  return data?.length ?? 0
}

export async function deleteMessage(messageId: string, agentId: string): Promise<boolean> {
  // Only the sender can delete their own message. Deliveries cascade via FK.
  const { data, error } = await getSupabaseClient()
    .from('messages')
    .delete()
    .eq('id', messageId)
    .eq('sender_id', agentId)
    .select('id')

  if (error) throw error
  return (data?.length ?? 0) > 0
}

// --- Internal helpers -------------------------------------------------------

interface DeliveryRow {
  id: string
  message_id: string
  recipient_agent_id: string
  status: string
  delivered_at: string | null
  read_at: string | null
  created_at: string
}

async function fetchDeliveries(messageIds: string[]): Promise<Map<string, DeliveryRow>> {
  if (messageIds.length === 0) return new Map()
  const { data, error } = await getSupabaseClient()
    .from('message_deliveries')
    .select('*')
    .in('message_id', messageIds)

  if (error) throw error
  const map = new Map<string, DeliveryRow>()
  for (const row of (data ?? []) as DeliveryRow[]) {
    // For 1:1 there's exactly one delivery per message. Last write wins if
    // there are somehow duplicates; group-conv support will need a richer
    // caller-scoped shape.
    map.set(row.message_id, row)
  }
  return map
}

function composeWithDelivery(
  message: Record<string, unknown>,
  delivery: DeliveryRow | undefined,
) {
  return {
    ...message,
    delivery_id: delivery?.id ?? null,
    status: delivery?.status ?? 'stored',
    delivered_at: delivery?.delivered_at ?? null,
    read_at: delivery?.read_at ?? null,
  }
}
