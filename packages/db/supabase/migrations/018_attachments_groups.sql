-- Migration 018: Attachments scoped to conversations (group support)
--
-- Migration 013 created `attachments` as 1:1 only, with (uploader_id,
-- recipient_id) as the target pair and an access check of "caller is
-- uploader OR recipient." When groups shipped in 017, that check was
-- never updated, so a member who uploaded a file into a group could
-- only be downloaded by themselves — every other active member got
-- 404. The migration 013 header comment already anticipated this
-- exact fix ("When groups ship, add a conversation_id column and
-- switch the participant check to 'is member of conversation_id'").
--
-- What this migration does:
--
--   1. Adds `conversation_id` (nullable) with FK to conversations,
--      ON DELETE CASCADE so deleting a group also tombstones its
--      attachment rows (the bytes in Supabase Storage are cleaned up
--      by the dangling-attachment GC job — tracked in the dashboard
--      backlog).
--   2. Relaxes `recipient_id` to nullable so group uploads can leave
--      it NULL while direct uploads continue to populate it.
--   3. Adds a CHECK constraint requiring EXACTLY ONE of
--      (recipient_id, conversation_id) to be set. This preserves the
--      direct path unchanged and opens the group path strictly.
--   4. Indexes `conversation_id` for "attachments in this group"
--      lookups by the future cleanup / admin paths.
--
-- Access control is still enforced at the application layer in
-- upload.service.ts and message.service.ts. Consistent with the rest
-- of the platform: the api-server is the only Supabase client, so RLS
-- is belt-and-suspenders and we skip it.
--
-- Backfill: every pre-018 row has recipient_id set and conversation_id
-- NULL (direct-only era). The CHECK constraint is satisfied for every
-- existing row without any UPDATE. No downtime, no rewrite.

BEGIN;

ALTER TABLE attachments
  ADD COLUMN IF NOT EXISTS conversation_id TEXT
  REFERENCES conversations(id) ON DELETE CASCADE;

ALTER TABLE attachments
  ALTER COLUMN recipient_id DROP NOT NULL;

-- Drop any stale variant of the constraint before re-adding, so this
-- migration is safe to re-run in a fresh-ish environment.
ALTER TABLE attachments
  DROP CONSTRAINT IF EXISTS attachments_target_exactly_one;

ALTER TABLE attachments
  ADD CONSTRAINT attachments_target_exactly_one CHECK (
    (recipient_id IS NOT NULL AND conversation_id IS NULL)
    OR (recipient_id IS NULL AND conversation_id IS NOT NULL)
  );

-- Partial index keeps the direct-only rows (majority) out of the
-- index, so it stays small and cheap.
CREATE INDEX IF NOT EXISTS idx_attachments_conversation
  ON attachments(conversation_id, created_at DESC)
  WHERE conversation_id IS NOT NULL;

COMMIT;
