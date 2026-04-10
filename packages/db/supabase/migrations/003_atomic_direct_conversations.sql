-- Add sorted agent pair columns to conversations for direct-type uniqueness.
-- This prevents the race condition where two agents messaging simultaneously
-- could create duplicate direct conversations.

ALTER TABLE conversations
  ADD COLUMN direct_agent_a TEXT REFERENCES agents(id),
  ADD COLUMN direct_agent_b TEXT REFERENCES agents(id);

-- Unique constraint: only one direct conversation per agent pair
-- agent_a is always the lexicographically smaller ID
ALTER TABLE conversations
  ADD CONSTRAINT unique_direct_pair UNIQUE (direct_agent_a, direct_agent_b);

-- Check constraint: direct conversations MUST have the pair set, groups MUST NOT
ALTER TABLE conversations
  ADD CONSTRAINT direct_pair_check CHECK (
    (type = 'direct' AND direct_agent_a IS NOT NULL AND direct_agent_b IS NOT NULL AND direct_agent_a < direct_agent_b)
    OR (type = 'group' AND direct_agent_a IS NULL AND direct_agent_b IS NULL)
  );

-- Backfill existing direct conversations (if any)
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

-- Replace the old find function with an atomic find-or-create
DROP FUNCTION IF EXISTS find_direct_conversation(TEXT, TEXT);

-- Atomic find-or-create: uses INSERT ... ON CONFLICT to prevent race conditions
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
  v_is_new BOOLEAN;
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
    INSERT INTO conversations (id, type, direct_agent_a, direct_agent_b)
    VALUES (p_conv_id, 'direct', sorted_a, sorted_b);

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
