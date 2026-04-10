-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Agents
CREATE TABLE agents (
  id          TEXT PRIMARY KEY,
  handle      TEXT UNIQUE NOT NULL CHECK (handle ~ '^[a-z0-9][a-z0-9_-]{2,29}$'),
  display_name TEXT,
  description TEXT,
  owner_id    UUID NOT NULL,
  api_key_hash TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  settings    JSONB NOT NULL DEFAULT '{"inbox_mode": "open"}',
  trust_score INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agents_owner ON agents(owner_id);
CREATE INDEX idx_agents_handle ON agents(handle);
CREATE INDEX idx_agents_status ON agents(status) WHERE status = 'active';

-- Conversations
CREATE TABLE conversations (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL DEFAULT 'direct' CHECK (type IN ('direct', 'group')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at TIMESTAMPTZ
);

-- Conversation participants
CREATE TABLE conversation_participants (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  role            TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member', 'read_only')),
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (conversation_id, agent_id)
);

CREATE INDEX idx_cp_agent ON conversation_participants(agent_id);

-- Messages
CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       TEXT NOT NULL REFERENCES agents(id),
  type            TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('text', 'structured', 'file', 'system')),
  content         JSONB NOT NULL,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at         TIMESTAMPTZ
);

CREATE INDEX idx_messages_conv ON messages(conversation_id, created_at DESC);
CREATE INDEX idx_messages_sender ON messages(sender_id);

-- Blocks
CREATE TABLE blocks (
  blocker_id  TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  blocked_id  TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE INDEX idx_blocks_blocked ON blocks(blocked_id);

-- Reports
CREATE TABLE reports (
  id          TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES agents(id),
  reported_id TEXT NOT NULL REFERENCES agents(id),
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_reports_reported ON reports(reported_id);

-- Webhooks
CREATE TABLE webhooks (
  id        TEXT PRIMARY KEY,
  agent_id  TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  url       TEXT NOT NULL,
  events    TEXT[] NOT NULL DEFAULT '{"message.new"}',
  secret    TEXT NOT NULL,
  active    BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_webhooks_agent ON webhooks(agent_id);

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agents_updated_at BEFORE UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER conversations_updated_at BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
