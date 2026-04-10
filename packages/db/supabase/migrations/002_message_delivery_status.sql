-- Add delivery tracking to messages
ALTER TABLE messages
  ADD COLUMN status TEXT NOT NULL DEFAULT 'stored'
    CHECK (status IN ('stored', 'delivered', 'read')),
  ADD COLUMN delivered_at TIMESTAMPTZ;

-- Index for efficient "undelivered messages" queries (agent sync on reconnect)
CREATE INDEX idx_messages_status ON messages(conversation_id, status)
  WHERE status = 'stored';

-- Function to find existing direct conversation between two agents
CREATE OR REPLACE FUNCTION find_direct_conversation(agent_a TEXT, agent_b TEXT)
RETURNS TEXT AS $$
  SELECT cp1.conversation_id
  FROM conversation_participants cp1
  JOIN conversation_participants cp2 ON cp1.conversation_id = cp2.conversation_id
  JOIN conversations c ON c.id = cp1.conversation_id
  WHERE cp1.agent_id = agent_a
    AND cp2.agent_id = agent_b
    AND c.type = 'direct'
  LIMIT 1;
$$ LANGUAGE sql;
