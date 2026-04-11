-- Fix contacts & directory: single-query contact listing, notes, duplicate report
-- prevention, pg_trgm index for directory search, discoverable setting support.

-- ─── 1. Add notes column to contacts ───────────────────────────────────────
ALTER TABLE contacts ADD COLUMN notes TEXT;

-- ─── 2. Prevent duplicate reports from same reporter ───────────────────────
-- An agent can only report another agent once. To re-report, the old report
-- must be a different dispute (handled at application level with clear error).
ALTER TABLE reports ADD CONSTRAINT reports_unique_pair UNIQUE (reporter_id, reported_id);

-- ─── 3. pg_trgm for efficient ILIKE / substring search on display_name ────
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX idx_agents_display_name_trgm
  ON agents USING gin (display_name gin_trgm_ops);

-- Handle prefix search can use the existing B-tree idx_agents_handle,
-- but a trgm GIN index is more flexible for partial matches too.
CREATE INDEX idx_agents_handle_trgm
  ON agents USING gin (handle gin_trgm_ops);

-- ─── 4. RPC: list contacts with a single JOIN query ────────────────────────
-- Returns contacts joined with agent profiles, sorted alphabetically by handle,
-- with correct total (only counts active agents, not raw contact rows).
CREATE OR REPLACE FUNCTION list_contacts_v2(
  p_owner_id TEXT,
  p_limit    INTEGER DEFAULT 50,
  p_offset   INTEGER DEFAULT 0
)
RETURNS TABLE(
  handle       TEXT,
  display_name TEXT,
  description  TEXT,
  notes        TEXT,
  added_at     TIMESTAMPTZ,
  total        BIGINT
) AS $$
  WITH filtered AS (
    SELECT c.contact_agent_id, c.created_at, c.notes,
           a.handle, a.display_name, a.description
    FROM contacts c
    JOIN agents a ON a.id = c.contact_agent_id AND a.status = 'active'
    WHERE c.owner_agent_id = p_owner_id
  ),
  counted AS (
    SELECT COUNT(*) AS cnt FROM filtered
  )
  SELECT f.handle, f.display_name, f.description, f.notes,
         f.created_at AS added_at, counted.cnt AS total
  FROM filtered f, counted
  ORDER BY f.handle ASC
  LIMIT p_limit OFFSET p_offset;
$$ LANGUAGE sql STABLE;

-- ─── 5. RPC: check single contact existence ────────────────────────────────
CREATE OR REPLACE FUNCTION check_contact(p_owner TEXT, p_contact_handle TEXT)
RETURNS TABLE(
  is_contact BOOLEAN,
  added_at   TIMESTAMPTZ,
  notes      TEXT
) AS $$
  SELECT
    TRUE AS is_contact,
    c.created_at AS added_at,
    c.notes
  FROM contacts c
  JOIN agents a ON a.id = c.contact_agent_id AND a.handle = p_contact_handle
  WHERE c.owner_agent_id = p_owner
  LIMIT 1;
$$ LANGUAGE sql STABLE;

-- ─── 6. RPC: check block in either direction ──────────────────────────────
-- Returns true if EITHER agent has blocked the other.
CREATE OR REPLACE FUNCTION is_blocked_either(p_agent_a TEXT, p_agent_b TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS(
    SELECT 1 FROM blocks
    WHERE (blocker_id = p_agent_a AND blocked_id = p_agent_b)
       OR (blocker_id = p_agent_b AND blocked_id = p_agent_a)
  );
$$ LANGUAGE sql STABLE;

-- ─── 7. RPC: directory search with optional contact context ────────────────
-- When p_caller_id is provided, includes in_contacts flag per result.
CREATE OR REPLACE FUNCTION search_directory(
  p_query     TEXT,
  p_limit     INTEGER DEFAULT 20,
  p_offset    INTEGER DEFAULT 0,
  p_caller_id TEXT DEFAULT NULL
)
RETURNS TABLE(
  handle       TEXT,
  display_name TEXT,
  description  TEXT,
  created_at   TIMESTAMPTZ,
  in_contacts  BOOLEAN
) AS $$
  SELECT
    a.handle,
    a.display_name,
    a.description,
    a.created_at,
    CASE
      WHEN p_caller_id IS NOT NULL THEN EXISTS(
        SELECT 1 FROM contacts c
        WHERE c.owner_agent_id = p_caller_id AND c.contact_agent_id = a.id
      )
      ELSE NULL
    END AS in_contacts
  FROM agents a
  WHERE a.status = 'active'
    AND (a.settings->>'discoverable')::boolean IS DISTINCT FROM false
    AND (
      a.handle ILIKE p_query || '%'
      OR a.display_name ILIKE '%' || p_query || '%'
    )
  ORDER BY a.handle ASC
  LIMIT p_limit OFFSET p_offset;
$$ LANGUAGE sql STABLE;

-- Count version for pagination total
CREATE OR REPLACE FUNCTION search_directory_count(p_query TEXT)
RETURNS BIGINT AS $$
  SELECT COUNT(*)
  FROM agents a
  WHERE a.status = 'active'
    AND (a.settings->>'discoverable')::boolean IS DISTINCT FROM false
    AND (
      a.handle ILIKE p_query || '%'
      OR a.display_name ILIKE '%' || p_query || '%'
    );
$$ LANGUAGE sql STABLE;
