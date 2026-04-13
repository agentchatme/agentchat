-- Migration 016: WhatsApp-style message deletion
--
-- Two deletion models live side-by-side, because any messaging platform
-- that only offers one of them feels broken to users:
--
-- 1) Delete-for-me (scope=me): any participant (sender OR recipient) can
--    hide any message from their own view. Recorded in message_hides.
--    Read paths LEFT JOIN against this table and drop rows the caller
--    has hidden. The other participant's view is unaffected.
--
-- 2) Delete-for-everyone (scope=everyone): ONLY the sender, ONLY within
--    a 48h window (enforced at the service layer, not here — the server
--    clock is authoritative). The message row is tombstoned in place:
--    deleted_at is stamped, content is replaced with '{}'::jsonb, and
--    the row stays in the table so:
--      - seq ordering remains contiguous (no holes in the per-
--        conversation sequence, which clients use for gap detection)
--      - recipients who already synced the original content get a
--        message.deleted event and know to overwrite their local copy
--      - history queries return a tombstone placeholder instead of a
--        missing row, mirroring the WhatsApp UX
--
--    Attachment cascade (storage object + attachments row) is done by
--    the service layer because the row-level tombstone alone doesn't
--    reclaim the bytes in Supabase Storage, and this migration has no
--    access to the storage API.
--
-- Senders don't have a delivery envelope for their own messages (see
-- the fan-out in send_message_atomic — p_sender_id is excluded), so the
-- hide helper below only transitions message_deliveries for recipients.

-- 1. Tombstone column on messages -------------------------------------------

ALTER TABLE messages
  ADD COLUMN deleted_at TIMESTAMPTZ;

-- Partial index for "non-tombstoned messages in this conversation, newest
-- first" — the hot read path for history. Most messages will never be
-- deleted, so a partial index keeps the write cost near zero while making
-- the history scan tight.
CREATE INDEX idx_messages_live
  ON messages(conversation_id, seq DESC)
  WHERE deleted_at IS NULL;

-- 2. Per-agent soft-delete table --------------------------------------------

CREATE TABLE message_hides (
  message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  hidden_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, agent_id)
);

-- The composite PK covers the "has this agent hidden this message"
-- lookup. For the history-read filter ("which of these message_ids has
-- agent X hidden") we rely on the same PK — the query is an IN-list
-- against message_id combined with an eq on agent_id, which Postgres
-- resolves via the PK index.

-- 3. Atomic hide helper ------------------------------------------------------
--
-- Insert the hide row and — if the caller is a recipient with a pending
-- delivery — advance that envelope to 'delivered' in the same transaction.
-- Without the envelope bump the sync drain would keep returning a message
-- the agent has already explicitly hidden, and the client would be forced
-- to re-hide on every drain. The UPDATE is a no-op for senders (who have
-- no envelope) and for envelopes already past 'stored'.

CREATE OR REPLACE FUNCTION hide_message_for_agent(
  p_message_id TEXT,
  p_agent_id   TEXT
) RETURNS VOID AS $$
BEGIN
  INSERT INTO message_hides (message_id, agent_id)
  VALUES (p_message_id, p_agent_id)
  ON CONFLICT (message_id, agent_id) DO NOTHING;

  UPDATE message_deliveries
  SET status = 'delivered',
      delivered_at = NOW()
  WHERE message_id = p_message_id
    AND recipient_agent_id = p_agent_id
    AND status = 'stored';
END;
$$ LANGUAGE plpgsql;
