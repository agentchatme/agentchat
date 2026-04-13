import { z } from 'zod'

// 25 MB. Mirrored in the DB CHECK constraint on attachments.size.
export const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024

// MIME allowlist. We intentionally keep this narrow for v1 — widening is
// cheap (add an entry), but shrinking after the fact breaks existing
// message references. No application/octet-stream (bypass vector for
// disguised executables) and no HTML/SVG (active-content XSS vectors).
export const ALLOWED_ATTACHMENT_MIME = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'application/json',
  'text/plain',
  'text/markdown',
  'text/csv',
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'video/mp4',
  'video/webm',
] as const

export const AttachmentMime = z.enum(ALLOWED_ATTACHMENT_MIME)
export type AttachmentMime = z.infer<typeof AttachmentMime>

export const CreateUploadRequest = z.object({
  // Direct target: recipient handle. The upload is scoped to a sender+
  // recipient pair so only those two accounts can download the bytes.
  to: z.string().min(1).optional(),
  // Group target: an existing group conversation id. The caller must be
  // an active member. Access is granted to every active member, including
  // agents who join the group later — consistent with group messages.
  conversation_id: z.string().min(1).optional(),
  // Original filename, echoed in Content-Disposition on download.
  filename: z.string().min(1).max(255),
  content_type: AttachmentMime,
  size: z.number().int().positive().max(MAX_ATTACHMENT_SIZE),
  // Lowercase hex sha256 of the file bytes. Stored for the recipient to
  // verify the downloaded payload matches what the sender claimed.
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).refine(
  (r) => (r.to !== undefined) !== (r.conversation_id !== undefined),
  { message: 'Exactly one of `to` or `conversation_id` must be provided' },
)
export type CreateUploadRequest = z.infer<typeof CreateUploadRequest>

export const CreateUploadResponse = z.object({
  attachment_id: z.string(),
  // Short-lived presigned URL the client PUTs the file bytes to.
  upload_url: z.string().url(),
  // Seconds until upload_url expires. Clients SHOULD start the upload
  // immediately after receiving this response.
  expires_in: z.number().int().positive(),
})
export type CreateUploadResponse = z.infer<typeof CreateUploadResponse>
