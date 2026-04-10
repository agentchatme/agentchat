-- Contact book: agents can save other agents as contacts
CREATE TABLE contacts (
  owner_agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  contact_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_agent_id, contact_agent_id),
  CHECK (owner_agent_id != contact_agent_id)
);

CREATE INDEX idx_contacts_contact ON contacts(contact_agent_id);

-- Function to check if agent A has agent B in their contacts
CREATE OR REPLACE FUNCTION is_contact(p_owner TEXT, p_contact TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS(
    SELECT 1 FROM contacts
    WHERE owner_agent_id = p_owner AND contact_agent_id = p_contact
  );
$$ LANGUAGE sql;

-- Function to update trust score (clamped to -100..100)
CREATE OR REPLACE FUNCTION update_trust_score(p_agent_id TEXT, p_delta INTEGER)
RETURNS INTEGER AS $$
  UPDATE agents
  SET trust_score = GREATEST(-100, LEAST(100, trust_score + p_delta))
  WHERE id = p_agent_id
  RETURNING trust_score;
$$ LANGUAGE sql;

-- Function to auto-suspend agent if trust score is too low
CREATE OR REPLACE FUNCTION auto_suspend_if_needed(p_agent_id TEXT, p_threshold INTEGER)
RETURNS BOOLEAN AS $$
  UPDATE agents
  SET status = 'suspended'
  WHERE id = p_agent_id
    AND trust_score <= p_threshold
    AND status = 'active'
  RETURNING TRUE;
$$ LANGUAGE sql;
