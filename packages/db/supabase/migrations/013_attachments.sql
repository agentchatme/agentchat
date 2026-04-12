-- Migration 013: File attachments
--
-- Agents need to attach images, PDFs, and small binaries to messages. The
-- MVP flow is a two-step "signed upload, signed download" dance:
--
--   1. POST /v1/uploads  — caller provides filename/content_type/size/sha256
--                          plus the recipient handle. Server validates the
--                          metadata, inserts a row here, and hands back a
--                          short-lived presigned upload URL pointing at
--                          Supabase Storage. No bytes travel through the
--                          api-server — the client PUTs directly to storage.
--
--   2. GET /v1/attachments/:id — participant (uploader or recipient) auth'd.
--                          Server looks up the row, confirms the caller is
--                          allowed, and 302-redirects to a short-lived
--                          signed download URL from Supabase Storage.
--                          We redirect instead of proxying so 25 MB files
--                          don't materialize in api-server memory.
--
-- The row exists AHEAD of the actual bytes being uploaded — if the client
-- never PUTs (or the PUT fails), the row points at nothing and GET
-- /v1/attachments/:id will 404 out of Supabase Storage. That's OK: the
-- attachment_id isn't exposed anywhere until the uploader references it
-- in a subsequent message, so dangling rows are effectively invisible.
--
-- Garbage collection of dangling attachments (row exists, bytes missing,
-- never referenced by a message) is left for a future cleanup job. See
-- the operator checklist in the plan.
--
-- Access control: uploader_id + recipient_id are denormalized onto the row.
-- For the MVP (1:1 conversations only) this is exactly right. When groups
-- ship, add a conversation_id column and switch the participant check to
-- "is member of conversation_id" — the current shape is a strict subset.

CREATE TABLE attachments (
  id              TEXT PRIMARY KEY,

  -- Who uploaded the file. They can always re-download it (useful for
  -- clients that want to render a local preview of their own message).
  uploader_id     TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,

  -- Who the uploader said this is for. Only the recipient (and the uploader)
  -- can fetch the bytes. Recorded at upload time — not later when the
  -- message is sent — so the check works even if the message is never sent.
  recipient_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,

  -- Client-provided metadata. `filename` is echoed back in the download
  -- response Content-Disposition so the recipient sees the original name.
  -- `content_type` is client-claimed and NOT server-verified — we enforce
  -- it's on an allowlist before accepting the upload, but we do not sniff
  -- the bytes. Recipients should treat content_type as a hint, not a
  -- security boundary (which is why we always use Content-Disposition:
  -- attachment and never inline-render).
  filename        TEXT NOT NULL,
  content_type    TEXT NOT NULL,

  -- Byte length as declared by the client. Enforced ≤ 25 MB at the API
  -- layer before we insert the row. The actual bytes in storage may not
  -- match this if the client lies — the presigned URL has its own size
  -- ceiling on the Supabase Storage side.
  size            BIGINT NOT NULL CHECK (size >= 0 AND size <= 26214400),

  -- Client-provided sha256 (lowercase hex). Stored so the recipient can
  -- verify the downloaded bytes match what the sender claimed. We don't
  -- server-verify because the server never sees the bytes.
  sha256          TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),

  -- Object key within the Supabase Storage bucket. Usually equal to `id`.
  -- Stored explicitly so a future migration can change the key scheme
  -- without breaking existing rows.
  storage_path    TEXT NOT NULL,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lookup: "attachments I uploaded" / "attachments sent to me" — both
-- covered by this pair. Sorted by created_at DESC so history views get
-- newest-first for free.
CREATE INDEX idx_attachments_uploader
  ON attachments(uploader_id, created_at DESC);

CREATE INDEX idx_attachments_recipient
  ON attachments(recipient_id, created_at DESC);
