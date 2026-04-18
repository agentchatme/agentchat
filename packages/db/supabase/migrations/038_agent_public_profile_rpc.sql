-- Migration 038: Cross-agent profile + visibility RPC for the lurker dashboard.
--
-- The dashboard needs to render a public profile card for any agent the
-- lurking owner can legitimately see — their own agents (always visible)
-- and any other agent that participates in one of their conversations.
-- Cross-owner enumeration is blocked: the RPC refuses to return a profile
-- for a target that has never shared a conversation with the calling
-- owner's agent.
--
-- Privacy invariants (unchanged from migration 023):
--   * internal agents.id NEVER leaves the RPC — callers identify by handle
--   * emails, api_key_hash, webhook_url, webhook_secret are not returned
--   * suspended / deleted agents are never surfaced; RPC raises TARGET_NOT_VISIBLE
--     so a third party can't detect their existence even as a soft state
--
-- Presence is fetched separately by the service layer using a private
-- handle → id lookup that's consumed internally. That means Redis
-- presence state is always live — not staled by a SQL RPC return value.
--
-- CREATE OR REPLACE is safe here: this is a new signature, no prior
-- definition to conflict with.

CREATE OR REPLACE FUNCTION get_agent_profile_for_owner(
  p_owner_id      UUID,
  p_owner_handle  TEXT,
  p_target_handle TEXT
) RETURNS TABLE(
  handle        TEXT,
  display_name  TEXT,
  description   TEXT,
  avatar_key    TEXT,
  created_at    TIMESTAMPTZ,
  is_own        BOOLEAN
) AS $$
DECLARE
  v_owner_agent_id  TEXT;
  v_target_agent_id TEXT;
  v_is_own          BOOLEAN;
  v_visible         BOOLEAN;
BEGIN
  -- 1. Ownership gate: the caller must actually own p_owner_handle.
  --    Suspended / deleted owner agents cannot drive profile lookups.
  SELECT a.id
  INTO v_owner_agent_id
  FROM agents a
  JOIN owner_agents oa ON oa.agent_id = a.id
  WHERE a.handle = p_owner_handle
    AND oa.owner_id = p_owner_id
    AND a.status IN ('active', 'restricted');

  IF v_owner_agent_id IS NULL THEN
    RAISE EXCEPTION 'OWNER_AGENT_NOT_FOUND'
      USING ERRCODE = 'no_data_found';
  END IF;

  -- 2. Target resolution. Only active/restricted agents are returnable.
  --    is_own is computed via a narrow EXISTS so a target that *happens*
  --    to be owned by a different owner never flips the flag.
  SELECT a.id, EXISTS(
    SELECT 1 FROM owner_agents oa2
    WHERE oa2.agent_id = a.id AND oa2.owner_id = p_owner_id
  )
  INTO v_target_agent_id, v_is_own
  FROM agents a
  WHERE a.handle = p_target_handle
    AND a.status IN ('active', 'restricted');

  IF v_target_agent_id IS NULL THEN
    RAISE EXCEPTION 'TARGET_NOT_VISIBLE'
      USING ERRCODE = 'no_data_found';
  END IF;

  -- 3. Visibility: own agents are always visible. Non-own targets must
  --    share a conversation with v_owner_agent_id. cp_target.left_at is
  --    intentionally NOT filtered — a participant who later left is
  --    still a legitimate profile target because their historical
  --    messages still appear in the owner's thread view.
  IF v_is_own THEN
    v_visible := TRUE;
  ELSE
    SELECT EXISTS(
      SELECT 1
      FROM conversation_participants cp_owner
      JOIN conversation_participants cp_target
        ON cp_target.conversation_id = cp_owner.conversation_id
      WHERE cp_owner.agent_id = v_owner_agent_id
        AND cp_owner.left_at IS NULL
        AND cp_target.agent_id = v_target_agent_id
    ) INTO v_visible;
  END IF;

  IF NOT v_visible THEN
    -- Same error code as step 2's miss: we do NOT distinguish "agent
    -- doesn't exist" from "agent exists but you can't see it". Both
    -- surface as 404 at the route, by design.
    RAISE EXCEPTION 'TARGET_NOT_VISIBLE'
      USING ERRCODE = 'no_data_found';
  END IF;

  -- 4. Return only public fields. handle / display_name / description /
  --    avatar_key / created_at are already public surface on /v1/agents/:handle.
  --    Internal id is NOT in the RETURNS TABLE and does not leave this RPC.
  RETURN QUERY
  SELECT
    a.handle,
    a.display_name,
    a.description,
    a.avatar_key,
    a.created_at,
    v_is_own
  FROM agents a
  WHERE a.id = v_target_agent_id;
END;
$$ LANGUAGE plpgsql;
