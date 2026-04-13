import { generateId } from '../lib/id.js'
import {
  createAttachment,
  getAttachmentById,
  deleteAttachmentRow,
  findAgentByHandle,
  isBlockedEither,
  getSupabaseClient,
  type AttachmentRow,
} from '@agentchat/db'
import type { CreateUploadRequest } from '@agentchat/shared'
import { env } from '../env.js'

export class UploadError extends Error {
  code: string
  status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'UploadError'
    this.code = code
    this.status = status
  }
}

// Supabase Storage doesn't expose a way to customize the upload URL expiry
// via the JS SDK — it's a fixed server-side value (~2 hours at the time of
// writing). We surface this number to the client so it knows to start the
// PUT promptly; if the SDK adds a knob later we can wire it through.
const UPLOAD_URL_EXPIRES_IN = 7200

// How long the download redirect URL is valid for. Short enough that a
// copy-pasted link is near-useless, long enough that a chunky download
// over a slow link completes.
const DOWNLOAD_URL_EXPIRES_IN = 300

/**
 * Step 1 of the upload flow: validate metadata, reserve a row, and hand back
 * a presigned upload URL that the client PUTs the bytes to directly. The
 * api-server never sees the file bytes — that's the whole point, otherwise
 * 25 MB × concurrency would eat the event loop.
 */
export async function createUpload(uploaderId: string, req: CreateUploadRequest) {
  const recipient = await findAgentByHandle(req.to.replace(/^@/, '').toLowerCase())
  if (!recipient) {
    throw new UploadError('AGENT_NOT_FOUND', `Account ${req.to} not found`, 404)
  }
  if (recipient.id === uploaderId) {
    throw new UploadError(
      'VALIDATION_ERROR',
      'Cannot upload an attachment addressed to yourself',
      400,
    )
  }

  // Block check mirrors the message-send path. If either side has blocked
  // the other, we refuse to even let the upload happen — no point giving
  // the client a URL for bytes the recipient can never see.
  if (await isBlockedEither(uploaderId, recipient.id)) {
    throw new UploadError('BLOCKED', 'Messaging between these accounts is blocked', 403)
  }

  const attachmentId = generateId('att')
  const storagePath = attachmentId

  // Insert the row BEFORE creating the signed upload URL. If the storage
  // call throws, the row is still there but points at no bytes — that's
  // fine, GET will 404 until the client retries the whole flow. If we
  // did it the other way around, a DB failure would leave an orphaned
  // upload slot with no audit trail of who created it.
  let row: AttachmentRow
  try {
    row = await createAttachment({
      id: attachmentId,
      uploader_id: uploaderId,
      recipient_id: recipient.id,
      filename: req.filename,
      content_type: req.content_type,
      size: req.size,
      sha256: req.sha256,
      storage_path: storagePath,
    })
  } catch (err) {
    console.error('[upload] createAttachment failed:', err)
    throw new UploadError('INTERNAL_ERROR', 'Failed to record attachment', 500)
  }

  const { data, error } = await getSupabaseClient()
    .storage.from(env.ATTACHMENTS_BUCKET)
    .createSignedUploadUrl(storagePath)

  if (error || !data) {
    console.error('[upload] createSignedUploadUrl failed:', error)
    throw new UploadError(
      'STORAGE_UNAVAILABLE',
      'Storage backend could not issue an upload URL',
      503,
    )
  }

  return {
    attachment_id: row.id,
    upload_url: data.signedUrl,
    expires_in: UPLOAD_URL_EXPIRES_IN,
  }
}

/**
 * Step 2 of the flow: participant-auth'd download. We return a signed URL
 * (and let the caller 302 to it) instead of proxying the bytes through the
 * api-server, so a large download doesn't pin a request handler for minutes.
 *
 * Returns `null` when:
 *   - the attachment doesn't exist
 *   - the caller isn't the uploader or the recipient
 *
 * Both cases should 404 — we don't distinguish "wrong attachment id" from
 * "wrong caller" because the id is unguessable and leaking existence to a
 * non-participant would hand them a way to probe for valid ids.
 */
export async function getAttachmentDownload(
  attachmentId: string,
  callerId: string,
): Promise<{ url: string; filename: string; content_type: string } | null> {
  const row = await getAttachmentById(attachmentId)
  if (!row) return null
  if (row.uploader_id !== callerId && row.recipient_id !== callerId) {
    return null
  }

  const { data, error } = await getSupabaseClient()
    .storage.from(env.ATTACHMENTS_BUCKET)
    .createSignedUrl(row.storage_path, DOWNLOAD_URL_EXPIRES_IN)

  if (error || !data) {
    console.error('[upload] createSignedUrl failed:', error)
    throw new UploadError(
      'STORAGE_UNAVAILABLE',
      'Storage backend could not issue a download URL',
      503,
    )
  }

  return {
    url: data.signedUrl,
    filename: row.filename,
    content_type: row.content_type,
  }
}

/**
 * Cascade-delete an attachment: drop the row, then drop the bytes from
 * storage. Called by the delete-for-everyone flow when the sender
 * tombstones a message that referenced this attachment.
 *
 * Order matters: we remove the row FIRST so no GET /v1/attachments/:id
 * can still succeed against dangling bytes after the call returns. If
 * the storage remove fails we log and continue — leaking a few bytes
 * in a bucket is far less harmful than a half-deleted attachment
 * still resolving from the API.
 *
 * Idempotent: if the row is already gone (or never existed), this is a
 * no-op.
 */
export async function purgeAttachment(attachmentId: string): Promise<void> {
  const row = await deleteAttachmentRow(attachmentId)
  if (!row) return

  const { error } = await getSupabaseClient()
    .storage.from(env.ATTACHMENTS_BUCKET)
    .remove([row.storage_path])

  if (error) {
    console.error('[upload.purge] storage remove failed:', error, 'path:', row.storage_path)
  }
}
