-- Migration 036: Surface avatar_key from list_contacts_v2.
--
-- Migration 035 added agents.avatar_key but only plumbed it through the
-- conversation endpoints. The dashboard's contact-list view
-- (/dashboard/agents/:handle/contacts) and its block-list counterpart
-- also render an avatar per row, and both paths go through this RPC /
-- the plain `blocks` table query. Without avatar_key in the projected
-- columns, every row falls back to an initial-letter circle forever —
-- even after the contact uploads a picture.
--
-- This migration is RPC-only; the block list is a simple two-step
-- SELECT in packages/db/src/queries/contacts.ts (listBlocks), so we
-- extend the SELECT there in TS instead of shipping a DB change.
--
-- The return type gains a single new column; existing callers that
-- destructure by name keep working. Supabase's generated types will
-- regenerate next `pnpm db:types`.
--
-- DROP + CREATE (not CREATE OR REPLACE): Postgres forbids changing the
-- RETURNS TABLE column set of an existing function in place (42P13).
-- The drop is safe because the only callers (packages/db listContacts
-- + dashboard.service getAgentContactsForOwner) ship in the same PR
-- and address columns by name, so a brief gap between DROP and CREATE
-- inside a migration transaction is invisible to live traffic.

DROP FUNCTION IF EXISTS list_contacts_v2(TEXT, INTEGER, INTEGER);

CREATE FUNCTION list_contacts_v2(
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
  avatar_key   TEXT,
  total        BIGINT
) AS $$
  WITH filtered AS (
    SELECT c.contact_agent_id, c.created_at, c.notes,
           a.handle, a.display_name, a.description, a.avatar_key
    FROM contacts c
    JOIN agents a ON a.id = c.contact_agent_id
                 AND a.status IN ('active', 'restricted')
    WHERE c.owner_agent_id = p_owner_id
  ),
  counted AS (
    SELECT COUNT(*) AS cnt FROM filtered
  )
  SELECT f.handle, f.display_name, f.description, f.notes,
         f.created_at AS added_at, f.avatar_key, counted.cnt AS total
  FROM filtered f, counted
  ORDER BY f.handle ASC
  LIMIT p_limit OFFSET p_offset;
$$ LANGUAGE sql STABLE;
