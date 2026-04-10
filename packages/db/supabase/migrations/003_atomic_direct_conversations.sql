-- Add sorted agent pair columns to conversations for direct-type uniqueness.
-- This prevents the race condition where two agents messaging simultaneously
-- could create duplicate direct conversations.

ALTER TABLE conversations
  ADD COLUMN direct_agent_a TEXT REFERENCES agents(id),
  ADD COLUMN direct_agent_b TEXT REFERENCES agents(id),
  ADD COLUMN initiated_by TEXT REFERENCES agents(id),
  ADD COLUMN established BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill existing direct conversations BEFORE adding constraints
UPDATE conversations c
SET
  direct_agent_a = sub.agent_a,
  direct_agent_b = sub.agent_b
FROM (
  SELECT
    cp1.conversation_id,
    LEAST(cp1.agent_id, cp2.agent_id) AS agent_a,
    GREATEST(cp1.agent_id, cp2.agent_id) AS agent_b
  FROM conversation_participants cp1
  JOIN conversation_participants cp2
    ON cp1.conversation_id = cp2.conversation_id
    AND cp1.agent_id < cp2.agent_id
  JOIN conversations conv ON conv.id = cp1.conversation_id
  WHERE conv.type = 'direct'
) sub
WHERE c.id = sub.conversation_id;

-- Delete any direct conversations that couldn't be backfilled (orphans with missing participants)
DELETE FROM conversations
WHERE type = 'direct' AND direct_agent_a IS NULL;

-- NOW add constraints (all rows are clean)
ALTER TABLE conversations
  ADD CONSTRAINT unique_direct_pair UNIQUE (direct_agent_a, direct_agent_b);

ALTER TABLE conversations
  ADD CONSTRAINT direct_pair_check CHECK (
    (type = 'direct' AND direct_agent_a IS NOT NULL AND direct_agent_b IS NOT NULL AND direct_agent_a < direct_agent_b)
    OR (type = 'group' AND direct_agent_a IS NULL AND direct_agent_b IS NULL)
  );

-- Index for efficient cold outreach counting
CREATE INDEX idx_conversations_cold_outreach
  ON conversations(initiated_by, created_at)
  WHERE established = FALSE AND type = 'direct';

-- Replace the old find function with an atomic find-or-create
DROP FUNCTION IF EXISTS find_direct_conversation(TEXT, TEXT);

-- Atomic find-or-create: uses INSERT ... ON CONFLICT to prevent race conditions
-- p_agent_a = the initiator (sender of the first message)
CREATE OR REPLACE FUNCTION find_or_create_direct_conversation(
  p_agent_a TEXT,
  p_agent_b TEXT,
  p_conv_id TEXT
)
RETURNS TABLE(conversation_id TEXT, is_new BOOLEAN) AS $$
DECLARE
  sorted_a TEXT := LEAST(p_agent_a, p_agent_b);
  sorted_b TEXT := GREATEST(p_agent_a, p_agent_b);
  v_conv_id TEXT;
BEGIN
  -- Try to find existing first (fast path)
  SELECT c.id INTO v_conv_id
  FROM conversations c
  WHERE c.direct_agent_a = sorted_a AND c.direct_agent_b = sorted_b;

  IF v_conv_id IS NOT NULL THEN
    conversation_id := v_conv_id;
    is_new := FALSE;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Attempt insert — the unique constraint handles the race
  BEGIN
    INSERT INTO conversations (id, type, direct_agent_a, direct_agent_b, initiated_by)
    VALUES (p_conv_id, 'direct', sorted_a, sorted_b, p_agent_a);

    INSERT INTO conversation_participants (conversation_id, agent_id)
    VALUES (p_conv_id, p_agent_a), (p_conv_id, p_agent_b);

    conversation_id := p_conv_id;
    is_new := TRUE;
    RETURN NEXT;
    RETURN;
  EXCEPTION WHEN unique_violation THEN
    -- Another transaction won the race — return the existing one
    SELECT c.id INTO v_conv_id
    FROM conversations c
    WHERE c.direct_agent_a = sorted_a AND c.direct_agent_b = sorted_b;

    conversation_id := v_conv_id;
    is_new := FALSE;
    RETURN NEXT;
    RETURN;
  END;
END;
$$ LANGUAGE plpgsql;

-- Simpler read-only lookup (used for rate limit pre-check)
CREATE OR REPLACE FUNCTION find_direct_conversation(agent_a TEXT, agent_b TEXT)
RETURNS TEXT AS $$
  SELECT id FROM conversations
  WHERE direct_agent_a = LEAST(agent_a, agent_b)
    AND direct_agent_b = GREATEST(agent_a, agent_b);
$$ LANGUAGE sql;

-- Count active cold outreaches (unestablished conversations initiated today)
CREATE OR REPLACE FUNCTION count_cold_outreaches(p_agent_id TEXT, p_since TIMESTAMPTZ)
RETURNS INTEGER AS $$
  SELECT COALESCE(COUNT(*)::INTEGER, 0)
  FROM conversations
  WHERE initiated_by = p_agent_id
    AND established = FALSE
    AND type = 'direct'
    AND created_at >= p_since;
$$ LANGUAGE sql;
