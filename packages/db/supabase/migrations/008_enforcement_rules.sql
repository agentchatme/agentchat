-- Rip out trust score system, replace with 3-rule enforcement:
-- Rule 1: Flat 100/day cold outreach cap (existing infra)
-- Rule 2: Community enforcement with initiated_by filter
-- Rule 3: Flat 60 msg/sec global rate limit (Redis, no DB changes)

-- ─── 1. Add 'restricted' status ───────────────────────────────────────────
-- Restricted agents can message existing contacts but cannot cold-outreach.
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_status_check;
ALTER TABLE agents ADD CONSTRAINT agents_status_check
  CHECK (status IN ('active', 'restricted', 'suspended', 'deleted'));

-- ─── 2. Drop trust_score column ───────────────────────────────────────────
ALTER TABLE agents DROP COLUMN IF EXISTS trust_score;

-- ─── 3. Drop trust-related SQL functions ──────────────────────────────────
DROP FUNCTION IF EXISTS update_trust_score(TEXT, INTEGER);
DROP FUNCTION IF EXISTS auto_suspend_if_needed(TEXT, INTEGER);

-- ─── 4. Convert verified_only inbox mode → contacts_only ──────────────────
-- verified_only depended on trust tiers which no longer exist.
UPDATE agents
SET settings = jsonb_set(settings, '{inbox_mode}', '"contacts_only"')
WHERE settings->>'inbox_mode' = 'verified_only';

-- ─── 5. Count blocks with initiated_by filter ─────────────────────────────
-- Only counts blocks where the blocked agent INITIATED the conversation
-- with the blocker. This prevents coordinated mass-blocking attacks.
CREATE OR REPLACE FUNCTION count_initiated_blocks(
  p_agent_id TEXT,
  p_since    TIMESTAMPTZ
) RETURNS INTEGER AS $$
  SELECT COALESCE(COUNT(*)::INTEGER, 0)
  FROM blocks b
  WHERE b.blocked_id = p_agent_id
    AND b.created_at >= p_since
    AND EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.initiated_by = p_agent_id
        AND c.type = 'direct'
        AND c.direct_agent_a = LEAST(b.blocker_id, p_agent_id)
        AND c.direct_agent_b = GREATEST(b.blocker_id, p_agent_id)
    );
$$ LANGUAGE sql STABLE;

-- ─── 6. Count reports with initiated_by filter ────────────────────────────
CREATE OR REPLACE FUNCTION count_initiated_reports(
  p_agent_id TEXT,
  p_since    TIMESTAMPTZ
) RETURNS INTEGER AS $$
  SELECT COALESCE(COUNT(*)::INTEGER, 0)
  FROM reports r
  WHERE r.reported_id = p_agent_id
    AND r.created_at >= p_since
    AND EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.initiated_by = p_agent_id
        AND c.type = 'direct'
        AND c.direct_agent_a = LEAST(r.reporter_id, p_agent_id)
        AND c.direct_agent_b = GREATEST(r.reporter_id, p_agent_id)
    );
$$ LANGUAGE sql STABLE;

-- ─── 7. Set agent status (idempotent, skips deleted agents) ───────────────
CREATE OR REPLACE FUNCTION set_agent_status(
  p_agent_id TEXT,
  p_status   TEXT
) RETURNS BOOLEAN AS $$
  UPDATE agents SET status = p_status
  WHERE id = p_agent_id AND status NOT IN ('deleted')
  RETURNING TRUE;
$$ LANGUAGE sql;

-- ─── 8. Indexes for enforcement counting ──────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_blocks_blocked_created
  ON blocks(blocked_id, created_at);

CREATE INDEX IF NOT EXISTS idx_reports_reported_created
  ON reports(reported_id, created_at);
