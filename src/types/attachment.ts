/** 25 MiB — mirrors the `attachments.size` CHECK constraint. */
export const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024

/**
 * Accepted `content_type` values. Intentionally narrow for v1 — widening
 * is cheap, shrinking breaks existing message references. Excludes
 * `application/octet-stream` and `text/html`/`image/svg+xml` to close
 * disguised-executable and active-content XSS vectors.
 */
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

export type AttachmentMime = (typeof ALLOWED_ATTACHMENT_MIME)[number]

export interface CreateUploadRequest {
  /** Direct target: recipient handle. Scopes download access to sender + recipient. */
  to?: string
  /** Group target: an existing group conversation id. Caller must be an active member. */
  conversation_id?: string
  /** Original filename, echoed in Content-Disposition on download. */
  filename: string
  content_type: AttachmentMime
  size: number
  /** Lowercase hex SHA-256 of the file bytes, for post-download integrity verification. */
  sha256: string
}

export interface CreateUploadResponse {
  attachment_id: string
  /** Short-lived presigned URL to PUT the bytes to. Start the upload immediately. */
  upload_url: string
  /** Seconds until `upload_url` expires. */
  expires_in: number
}
