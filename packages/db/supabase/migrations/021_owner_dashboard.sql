-- Owner Dashboard foundation: owners, owner_agents, events, paused_by_owner,
-- and the rotate_api_key_atomic RPC that keeps rotation + claim-revocation
-- in one transaction.
--
-- This is additive only. No existing column is dropped, no existing behavior
-- changes until the application layer switches over in Phase D1.

-- ─── 1. owners ─────────────────────────────────────────────────────────────
-- One row per human using the dashboard. id mirrors auth.users.id so the
-- Supabase Auth session JWT maps directly to an owners row without an extra
-- lookup table. Soft-delete via deleted_at so we can free up an email for
-- re-use without losing the audit trail of historical ownership.
CREATE TABLE owners (
  id           UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email        TEXT        NOT NULL,
  display_name TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at   TIMESTAMPTZ,
  CONSTRAINT owners_email_lowercase CHECK (email = LOWER(email))
);

-- One active owner per email (parallel to agents_email_active_unique).
CREATE UNIQUE INDEX owners_email_active
  ON owners(email) WHERE deleted_at IS NULL;

CREATE TRIGGER owners_updated_at BEFORE UPDATE ON owners
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─── 2. Cross-contamination backstop ───────────────────────────────────────
-- The app-layer guards in /v1/register and /dashboard/auth/otp/request are
-- the primary defense. This trigger is the DB-level backstop that catches
-- any race between the two entry points — without it, two concurrent
-- transactions could both pass their app-layer check and both succeed.
--
-- Checks both directions because either insert could win the race:
--   - owners INSERT must not overlap with an active agent email
--   - agents INSERT must not overlap with an active owner email
CREATE OR REPLACE FUNCTION enforce_email_namespace_isolation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_TABLE_NAME = 'owners' THEN
    IF EXISTS (
      SELECT 1 FROM agents
      WHERE email = NEW.email AND status != 'deleted'
    ) THEN
      RAISE EXCEPTION 'EMAIL_IS_AGENT: % is registered as an agent', NEW.email
        USING ERRCODE = 'unique_violation';
    END IF;
  ELSIF TG_TABLE_NAME = 'agents' THEN
    IF EXISTS (
      SELECT 1 FROM owners
      WHERE email = NEW.email AND deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'EMAIL_IS_OWNER: % is registered as an owner', NEW.email
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER owners_namespace_isolation
  BEFORE INSERT OR UPDATE OF email ON owners
  FOR EACH ROW EXECUTE FUNCTION enforce_email_namespace_isolation();

CREATE TRIGGER agents_namespace_isolation
  BEFORE INSERT OR UPDATE OF email ON agents
  FOR EACH ROW EXECUTE FUNCTION enforce_email_namespace_isolation();

-- ─── 3. owner_agents ───────────────────────────────────────────────────────
-- Claim mapping. agent_id is the PK so one agent can only be claimed by one
-- owner at a time (attempting a second claim returns a unique-violation the
-- application maps to ALREADY_CLAIMED). Cascade both ways: deleting an owner
-- releases all their claims, deleting an agent also drops the claim.
CREATE TABLE owner_agents (
  agent_id   TEXT        PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  owner_id   UUID        NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_owner_agents_owner ON owner_agents(owner_id);

-- ─── 4. events ─────────────────────────────────────────────────────────────
-- Append-only security / meta event log. Message activity is deliberately
-- NOT duplicated here — the dashboard derives it from messages +
-- message_deliveries at read time and merges client-side (see §3.1.1).
CREATE TABLE events (
  id         TEXT        PRIMARY KEY,
  actor_type TEXT        NOT NULL CHECK (actor_type IN ('owner', 'agent', 'system')),
  actor_id   TEXT        NOT NULL,
  action     TEXT        NOT NULL,
  target_id  TEXT        NOT NULL,
  metadata   JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_events_target ON events(target_id, created_at DESC);
CREATE INDEX idx_events_actor  ON events(actor_type, actor_id, created_at DESC);

-- ─── 5. agents.paused_by_owner ─────────────────────────────────────────────
-- Enum column for the two pause modes. 'none' = normal, 'send' = agent
-- cannot send but still receives, 'full' = agent cannot send and push
-- fan-out + reconnect drain are also suppressed. Default 'none' so
-- existing agents are unchanged by the migration.
ALTER TABLE agents
  ADD COLUMN paused_by_owner TEXT NOT NULL DEFAULT 'none'
    CHECK (paused_by_owner IN ('none', 'send', 'full'));

-- ─── 6. rotate_api_key_atomic ──────────────────────────────────────────────
-- Atomically: update api_key_hash, delete any claim, emit one or two
-- events. Replaces the plain UPDATE in services/agent.service.ts.
--
-- The caller pre-generates both event IDs (matching the existing generateId
-- convention in lib/id.ts) so the RPC stays deterministic and doesn't need
-- to read back generated values. Second event is only inserted when a
-- claim actually existed — if the agent was never claimed, the DELETE is
-- a no-op and the revoked event is skipped.
CREATE OR REPLACE FUNCTION rotate_api_key_atomic(
  p_agent_id   TEXT,
  p_new_hash   TEXT,
  p_rotated_id TEXT,
  p_revoked_id TEXT
) RETURNS VOID AS $$
DECLARE
  v_deleted_owner UUID;
BEGIN
  -- 1. Rotate the credential.
  UPDATE agents
  SET api_key_hash = p_new_hash
  WHERE id = p_agent_id AND status != 'deleted';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'AGENT_NOT_FOUND: %', p_agent_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- 2. Drop any claim on this agent, capturing the owner for the event.
  DELETE FROM owner_agents
  WHERE agent_id = p_agent_id
  RETURNING owner_id INTO v_deleted_owner;

  -- 3. Always emit agent.key_rotated.
  INSERT INTO events (id, actor_type, actor_id, action, target_id, metadata)
  VALUES (p_rotated_id, 'agent', p_agent_id, 'agent.key_rotated', p_agent_id, '{}'::jsonb);

  -- 4. Only emit agent.claim_revoked if a claim was actually deleted.
  IF v_deleted_owner IS NOT NULL THEN
    INSERT INTO events (id, actor_type, actor_id, action, target_id, metadata)
    VALUES (
      p_revoked_id,
      'system',
      'system',
      'agent.claim_revoked',
      p_agent_id,
      jsonb_build_object('owner_id', v_deleted_owner, 'reason', 'key_rotated')
    );
  END IF;
END;
$$ LANGUAGE plpgsql;
