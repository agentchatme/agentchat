-- Migration 023: Fast dashboard message-list RPC
--
-- Collapses the 6 sequential roundtrips getAgentMessagesForOwner used to
-- make (findOwnedAgentByHandle → isParticipant → getConversation →
-- getConversationHide → messages SELECT → message_hides SELECT →
-- message_deliveries SELECT) into a single stored procedure. One network
-- hop from the API server to Postgres, one query plan, one round of
-- planning/JIT. Savings compound on every dashboard message-list load.
--
-- This also closes a pre-existing enforcement gap: the dashboard path
-- did NOT pass joined_seq to getConversationMessages, so an owner viewing
-- a group could technically read messages that landed before the claimed
-- agent joined. The service-level comment promised joined_seq caps would
-- apply, but the code missed it. The RPC enforces it unconditionally and
-- leaves no way to opt out.
--
-- Security invariants:
--   * Ownership check runs first. If the caller doesn't own the agent, we
--     raise AGENT_NOT_FOUND — same exception the service maps to 404, so
--     a curious owner can't distinguish "you don't own this agent" from
--     "this agent doesn't exist".
--   * Participation check runs second. If the claimed agent is not an
--     active participant (no row or left_at IS NOT NULL), we raise
--     CONVERSATION_NOT_FOUND. Same 404 shape as the agent case, so a
--     crafted conversation id can't be used to enumerate conversations
--     the agent doesn't belong to.
--   * Internal row ids never leave the function. sender_id is consumed
--     inside the query and replaced with is_own (boolean). owner_id is
--     consumed inside the agent lookup. The service layer receives rows
--     that are already safe to forward to the dashboard wire.
--   * joined_seq + hidden_at + message_hides + delivery scoping are all
--     applied in the single SELECT so there is no window where the owner
--     sees a row that the claimed agent itself would not.

CREATE OR REPLACE FUNCTION get_agent_messages_for_owner(
  p_owner_id        UUID,
  p_handle          TEXT,
  p_conversation_id TEXT,
  p_before_seq      BIGINT DEFAULT NULL,
  p_limit           INT    DEFAULT 50
) RETURNS TABLE(
  id              TEXT,
  client_msg_id   TEXT,
  conversation_id TEXT,
  seq             BIGINT,
  type            TEXT,
  content         JSONB,
  metadata        JSONB,
  created_at      TIMESTAMPTZ,
  is_own          BOOLEAN,
  delivery_id     TEXT,
  status          TEXT,
  delivered_at    TIMESTAMPTZ,
  read_at         TIMESTAMPTZ
) AS $$
DECLARE
  v_agent_id    TEXT;
  v_conv_type   TEXT;
  v_joined_seq  BIGINT;
  v_hidden_at   TIMESTAMPTZ;
BEGIN
  -- 1. Ownership: agent must exist, be non-deleted, and claimed by caller.
  --    Single index scan via agents.handle (UNIQUE) + PK lookup on
  --    owner_agents(agent_id). Status IN check mirrors
  --    findOwnedAgentByHandle so suspended agents stay invisible and
  --    restricted agents remain readable (the lurker can still observe
  --    their own restricted agent).
  SELECT a.id
  INTO v_agent_id
  FROM agents a
  JOIN owner_agents oa ON oa.agent_id = a.id
  WHERE a.handle = p_handle
    AND oa.owner_id = p_owner_id
    AND a.status IN ('active', 'restricted');

  IF v_agent_id IS NULL THEN
    RAISE EXCEPTION 'AGENT_NOT_FOUND'
      USING ERRCODE = 'no_data_found';
  END IF;

  -- 2. Participation + conversation type in one lookup.
  --    conversation_participants is keyed (conversation_id, agent_id) so
  --    this is a PK point read, and the conversations join is a PK
  --    lookup. left_at IS NULL enforces that departed group members
  --    cannot read history through the dashboard any more than they can
  --    through their own API. joined_seq is snapshotted at add-time so
  --    new group members see only post-join history.
  SELECT c.type, cp.joined_seq
  INTO v_conv_type, v_joined_seq
  FROM conversation_participants cp
  JOIN conversations c ON c.id = cp.conversation_id
  WHERE cp.conversation_id = p_conversation_id
    AND cp.agent_id = v_agent_id
    AND cp.left_at IS NULL;

  IF v_conv_type IS NULL THEN
    RAISE EXCEPTION 'CONVERSATION_NOT_FOUND'
      USING ERRCODE = 'no_data_found';
  END IF;

  -- 3. Hide cutoff for this agent (optional; NULL means no hide).
  --    conversation_hides PK is (agent_id, conversation_id) so another
  --    point read, resolvable from the index alone.
  SELECT ch.hidden_at
  INTO v_hidden_at
  FROM conversation_hides ch
  WHERE ch.agent_id = v_agent_id
    AND ch.conversation_id = p_conversation_id;

  -- 4. Main query. One scan over messages (uses idx_messages_conv_seq_desc),
  --    LEFT JOIN to message_deliveries scoped by conversation type, anti-
  --    join on message_hides to drop delete-for-me rows.
  --
  --    Delivery join key depends on conversation type:
  --      * direct — match on message_id only. There is exactly one delivery
  --        row per message (the non-sender's envelope; see §11.5 of the
  --        plan) and both sides observe that same row — the sender sees
  --        the receiver's delivered/read progress, the receiver sees
  --        their own state. Anything else would require two joins.
  --      * group — scope to the caller's own envelope so a sender sees
  --        'stored' (no row, COALESCE fills it in) for their own message
  --        and each recipient sees their personal read state. Mirrors
  --        fetchDeliveriesForRecipient() in packages/db/queries/messages.
  --
  --    is_own is computed in-SQL so sender_id never crosses the wire. The
  --    dashboard identifies agents by handle only — exposing sender_id
  --    would leak internal row ids the rest of the dashboard API already
  --    strips.
  RETURN QUERY
  SELECT
    m.id,
    m.client_msg_id,
    m.conversation_id,
    m.seq,
    m.type,
    m.content,
    m.metadata,
    m.created_at,
    (m.sender_id = v_agent_id) AS is_own,
    md.id                      AS delivery_id,
    COALESCE(md.status, 'stored') AS status,
    md.delivered_at,
    md.read_at
  FROM messages m
  LEFT JOIN message_deliveries md
    ON md.message_id = m.id
   AND (v_conv_type = 'direct' OR md.recipient_agent_id = v_agent_id)
  WHERE m.conversation_id = p_conversation_id
    AND (p_before_seq IS NULL OR m.seq < p_before_seq)
    AND m.seq >= v_joined_seq
    AND (v_hidden_at IS NULL OR m.created_at > v_hidden_at)
    AND NOT EXISTS (
      SELECT 1
      FROM message_hides mh
      WHERE mh.message_id = m.id
        AND mh.agent_id = v_agent_id
    )
  ORDER BY m.seq DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;
