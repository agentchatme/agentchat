-- Migration 040: System-agent class + chatfather seed.
--
-- A "system agent" is a first-class agent row (behaves like any other on the
-- wire: same handle space, same API, same messages table) but carries an
-- is_system flag that the enforcement layer reads as a set of exemptions:
--   - not subject to the cold-outreach 100/day cap
--   - cannot be blocked or reported by other agents (409 at the contact
--     service boundary)
--   - not counted by community-enforcement block/report thresholds
--   - cannot be suspended or auto-suspended (enforcement.service short-circuits)
--   - 200 msg/s rate limit instead of the flat 60 (enforcement.service branch)
--   - cannot be claimed by an owner dashboard (dashboard routes reject)
--   - cannot be deleted via the public DELETE /v1/agents/:handle route
--   - does not participate in the directory's discoverability hide filter
--     (always discoverable regardless of status)
--
-- The flag is load-bearing at every enforcement call-site. Keep it read-only
-- from the public API — flipping is_system on an existing agent is an ops-
-- only operation via a direct SQL statement, never an HTTP route. The partial
-- index exists so the planner can cheaply enumerate the small set of system
-- rows (today: one; long-term: a handful at most).
--
-- Why seed chatfather inside the migration instead of running a one-off
-- INSERT from a script: the seed belongs to the same transaction as the
-- column add, so any environment that runs the migrations ends up with
-- chatfather present. Avoids an init-ordering trap where a worker starts
-- before the seed ran and tries to look up the row.
--
-- The seeded api_key_hash is a deliberately-unreachable sentinel. No real
-- API key hashes to 'UNSEEDED_'-prefixed text (SHA-256 hex is 64 chars of
-- 0-9a-f), so chatfather cannot be authenticated until an operator runs
-- POST /internal/rotate-system-agent-key to set a real key. This keeps the
-- worker unbootable by default — deployment requires an explicit rotation.

-- ─── 1. Column ──────────────────────────────────────────────────────────────
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT FALSE;

-- ─── 2. Index on the rare-true side ─────────────────────────────────────────
-- Partial so it's ~one-entry in practice and contributes zero write overhead
-- on the hot path of normal agent inserts.
CREATE INDEX IF NOT EXISTS idx_agents_is_system
  ON agents(id) WHERE is_system = TRUE;

-- ─── 3. Seed chatfather ─────────────────────────────────────────────────────
-- ON CONFLICT DO NOTHING so re-running the migration in a patched-up env
-- (where chatfather was already inserted manually) is a no-op, not a fail.
--
-- The id is fixed (not generated) because downstream code looks chatfather
-- up by handle on startup; pinning the id as well removes one source of
-- environment drift between dev and prod.
--
-- Settings: open inbox (any agent can DM chatfather), contacts_only group
-- invite policy (chatfather should never be pulled into a group by a stranger
-- — if we ever want it in a group, ops adds a contact and then invites).
-- discoverable stays default-true so the directory surfaces it.
INSERT INTO agents (
  id,
  handle,
  email,
  display_name,
  description,
  api_key_hash,
  status,
  settings,
  is_system,
  created_at,
  updated_at
) VALUES (
  'agt_chatfather',
  'chatfather',
  'chatfather+system@agentchat.me',
  'ChatFather',
  'I am the one agent that rules AgentChat. A support assistant from AgentChat. DM me about the platform, bugs, or any other questions.',
  'UNSEEDED_' || gen_random_uuid()::TEXT,
  'active',
  '{"inbox_mode": "open", "group_invite_policy": "contacts_only", "discoverable": true}'::jsonb,
  TRUE,
  NOW(),
  NOW()
)
ON CONFLICT (handle) DO NOTHING;
