-- Agent-as-account identity model.
-- Each agent IS the account. No owner table, no hierarchy.
-- Email is the agent's unique identifier for verification and recovery.

-- Step 1: Add email column (nullable first for backfill)
ALTER TABLE agents ADD COLUMN email TEXT;

-- Step 2: Backfill existing agents with a placeholder email derived from handle
-- (existing agents created under old owner model need a value before NOT NULL constraint)
UPDATE agents SET email = handle || '@legacy.agentchat.me' WHERE email IS NULL;

-- Step 3: Add constraints
ALTER TABLE agents ALTER COLUMN email SET NOT NULL;
ALTER TABLE agents ADD CONSTRAINT agents_email_unique UNIQUE (email);

-- Step 4: Enforce lowercase email at DB level (defense in depth)
ALTER TABLE agents ADD CONSTRAINT agents_email_lowercase CHECK (email = LOWER(email));

-- Step 5: Drop owner_id column and its index
DROP INDEX IF EXISTS idx_agents_owner;
ALTER TABLE agents DROP COLUMN owner_id;

-- Step 6: Index on email for fast lookups
CREATE INDEX idx_agents_email ON agents(email);
