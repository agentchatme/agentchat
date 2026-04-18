-- Migration 037: Surface sender identity in the dashboard message RPC.
--
-- Migration 023 set a rule that sender_id never leaves the RPC — the
-- dashboard identifies agents by handle, and internal row ids shouldn't
-- cross the wire. That invariant still holds. But the dashboard group
-- view was left with only `is_own`, which is enough for DMs (one other
-- participant) and useless for groups with 3+ members — every incoming
-- row is indistinguishable from every other.
--
-- We extend the RETURNS TABLE with three identity fields sourced from
-- the agents table via a join on sender_id. Handles and display names
-- are already public (you see them on every /v1/agents/:handle response);
-- avatar_key needs the same avatar_key → avatar_url translation the
-- contacts path does, which happens in dashboard.service.ts.
--
-- For own-rows the three identity columns come back NULL — the client
-- already knows who "me" is and renders own messages without a sender
-- badge. Computing them anyway would be harmless; emitting NULL makes
-- the intent explicit at the SQL boundary.
--
-- DROP + CREATE (not CREATE OR REPLACE): Postgres forbids changing the
-- RETURNS TABLE shape of an existing function in place (42P13). Callers
-- address columns by name and the query path (service → route) ships in
-- the same deploy, so the brief window between DROP and CREATE inside
-- the migration transaction is invisible to live traffic.

DROP FUNCTION IF EXISTS get_agent_messages_for_owner(UUID, TEXT, TEXT, BIGINT, INT);

CREATE FUNCTION get_agent_messages_for_owner(
  p_owner_id        UUID,
  p_handle          TEXT,
  p_conversation_id TEXT,
  p_before_seq      BIGINT DEFAULT NULL,
  p_limit           INT    DEFAULT 50
) RETURNS TABLE(
  id                   TEXT,
  client_msg_id        TEXT,
  conversation_id      TEXT,
  seq                  BIGINT,
  type                 TEXT,
  content              JSONB,
  metadata             JSONB,
  created_at           TIMESTAMPTZ,
  is_own               BOOLEAN,
  sender_handle        TEXT,
  sender_display_name  TEXT,
  sender_avatar_key    TEXT,
  delivery_id          TEXT,
  status               TEXT,
  delivered_at         TIMESTAMPTZ,
  read_at              TIMESTAMPTZ
) AS $$
DECLARE
  v_agent_id    TEXT;
  v_conv_type   TEXT;
  v_joined_seq  BIGINT;
  v_hidden_at   TIMESTAMPTZ;
BEGIN
  -- 1. Ownership (unchanged from 023).
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

  -- 2. Participation + conversation type (unchanged from 023).
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

  -- 3. Hide cutoff (unchanged from 023).
  SELECT ch.hidden_at
  INTO v_hidden_at
  FROM conversation_hides ch
  WHERE ch.agent_id = v_agent_id
    AND ch.conversation_id = p_conversation_id;

  -- 4. Main query. Added LEFT JOIN to agents on sender_id to surface
  --    handle / display_name / avatar_key. LEFT JOIN (not inner) because
  --    we want rows to still come back if the sender row was hard-deleted
  --    — those render as "unknown sender" client-side rather than
  --    dropping the message entirely. Identity fields are NULLed for
  --    is_own rows so the dashboard doesn't paint a "me" badge on its
  --    own outbound messages.
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
    CASE WHEN m.sender_id = v_agent_id THEN NULL ELSE sender.handle END        AS sender_handle,
    CASE WHEN m.sender_id = v_agent_id THEN NULL ELSE sender.display_name END  AS sender_display_name,
    CASE WHEN m.sender_id = v_agent_id THEN NULL ELSE sender.avatar_key END    AS sender_avatar_key,
    md.id                      AS delivery_id,
    COALESCE(md.status, 'stored') AS status,
    md.delivered_at,
    md.read_at
  FROM messages m
  LEFT JOIN agents sender ON sender.id = m.sender_id
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
