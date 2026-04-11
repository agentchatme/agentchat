-- Allow email reuse after account deletion.
-- The absolute UNIQUE constraint on email blocks registration even when the
-- previous account is deleted. Replace with a partial unique index that only
-- enforces uniqueness among non-deleted accounts.

-- 1. Drop the absolute unique constraint
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_email_unique;

-- 2. Add partial unique index — only active/restricted/suspended accounts
--    compete for email uniqueness. Deleted accounts are excluded.
CREATE UNIQUE INDEX agents_email_active_unique
  ON agents(email)
  WHERE status != 'deleted';
