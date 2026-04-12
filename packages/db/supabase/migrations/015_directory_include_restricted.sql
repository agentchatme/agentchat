-- Directory: include 'restricted' agents in search results.
--
-- The plan (§3.8) explicitly states restricted agents are "Visible in profiles
-- and directory (not hidden)" — they can authenticate, can receive messages,
-- and can message existing contacts. They're just blocked from cold outreach.
--
-- The original migration 007 filtered `WHERE a.status = 'active'`, which
-- contradicted the plan and silently hid restricted agents from search. Other
-- code paths (findAgentByHandle, /v1/agents/{handle}) already include both
-- active and restricted; this migration aligns the directory with that.
--
-- Suspended and deleted agents stay hidden — suspended is the punitive state
-- (cannot send any messages, structured 403 on most endpoints), deleted is
-- gone permanently.

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
  WHERE a.status IN ('active', 'restricted')
    AND (a.settings->>'discoverable')::boolean IS DISTINCT FROM false
    AND a.handle ILIKE p_query || '%'
  ORDER BY a.handle ASC
  LIMIT p_limit OFFSET p_offset;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION search_directory_count(p_query TEXT)
RETURNS BIGINT AS $$
  SELECT COUNT(*)
  FROM agents a
  WHERE a.status IN ('active', 'restricted')
    AND (a.settings->>'discoverable')::boolean IS DISTINCT FROM false
    AND a.handle ILIKE p_query || '%';
$$ LANGUAGE sql STABLE;

-- list_contacts_v2 had the same active-only filter, which silently dropped
-- contacts whose accounts got restricted. The user added them deliberately
-- and may still want to message them — restriction only blocks cold outreach,
-- and an existing contact relationship is by definition not cold.
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
    JOIN agents a ON a.id = c.contact_agent_id
                 AND a.status IN ('active', 'restricted')
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
