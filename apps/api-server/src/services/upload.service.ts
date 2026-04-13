import { generateId } from '../lib/id.js'
import {
  createAttachment,
  getAttachmentById,
  findAgentByHandle,
  isBlockedEither,
  getSupabaseClient,
  findGroupById,
  getGroupParticipantRole,
  type AttachmentRow,
} from '@agentchat/db'
import type { CreateUploadRequest } from '@agentchat/shared'
import { env } from '../env.js'
import { resolveDeletedGroupInfoForCaller } from './group.service.js'

export class UploadError extends Error {
  code: string
  status: number
  // Mirrors GroupError/MessageError.details — populated for GROUP_DELETED
  // (410) on the group upload + download paths so the SDK can surface
  // "group was deleted by @alice" without a second round-trip.
  details?: Record<string, unknown>

  constructor(
    code: string,
    message: string,
    status: number,
    details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'UploadError'
    this.code = code
    this.status = status
    this.details = details
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
 *
 * Two target modes (enforced exactly-one by the shared zod schema):
 *   - Direct: `to` is a recipient handle → scoped to (uploader, recipient).
 *   - Group: `conversation_id` is a group id → scoped to every active
 *     member of the group, including future joiners.
 */
export async function createUpload(uploaderId: string, req: CreateUploadRequest) {
  let recipientId: string | null = null
  let conversationId: string | null = null

  if (req.conversation_id !== undefined) {
    // Group upload path. Group membership IS the consent — no block or
    // inbox_mode checks apply, mirroring sendGroupMessage. We do require
    // the group to exist and the caller to be an ACTIVE member (left_at
    // IS NULL), so an ex-member can't dump files back into a group.
    const group = await findGroupById(req.conversation_id)
    if (!group) {
      throw new UploadError('GROUP_NOT_FOUND', 'Group not found', 404)
    }
    // Deleted-group check: former members get a 410 with metadata so
    // the SDK can render "group was deleted by @alice"; non-members
    // still get the masked 404 below.
    if (group.deleted_at) {
      const deletedCheck = await resolveDeletedGroupInfoForCaller(
        req.conversation_id,
        uploaderId,
      )
      if (deletedCheck?.kind === 'gone') {
        throw new UploadError(
          'GROUP_DELETED',
          'Group has been deleted',
          410,
          deletedCheck.info as unknown as Record<string, unknown>,
        )
      }
      throw new UploadError('GROUP_NOT_FOUND', 'Group not found', 404)
    }
    const role = await getGroupParticipantRole(req.conversation_id, uploaderId)
    if (!role) {
      // Hide existence of the group from non-members — same 404 shape
      // the message send path uses.
      throw new UploadError('GROUP_NOT_FOUND', 'Group not found', 404)
    }
    conversationId = req.conversation_id
  } else {
    // Direct upload path (unchanged from pre-018 behaviour).
    const rawTo = req.to as string
    const recipient = await findAgentByHandle(rawTo.replace(/^@/, '').toLowerCase())
    if (!recipient) {
      throw new UploadError('AGENT_NOT_FOUND', `Account ${rawTo} not found`, 404)
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
    recipientId = recipient.id
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
      recipient_id: recipientId,
      conversation_id: conversationId,
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
 *   - the caller is not authorized (direct: not uploader/recipient; group:
 *     not an active member)
 *
 * Both cases collapse to 404 — we don't distinguish "wrong id" from "wrong
 * caller" because the id is unguessable and leaking existence to a non-
 * participant would hand them a way to probe for valid ids.
 */
export async function getAttachmentDownload(
  attachmentId: string,
  callerId: string,
): Promise<{ url: string; filename: string; content_type: string } | null> {
  const row = await getAttachmentById(attachmentId)
  if (!row) return null

  // Uploader always retains access — they created the file and may want
  // to render it in their own local preview even after leaving a group.
  if (row.uploader_id !== callerId) {
    if (row.conversation_id !== null) {
      // Group attachment. If the group is deleted and the caller was a
      // former member, surface a 410 with DeletedGroupInfo so the SDK
      // can show "the group was deleted by @alice" instead of a blank
      // 404 on the download link. Non-members still get the null→404
      // mask below.
      const deletedCheck = await resolveDeletedGroupInfoForCaller(
        row.conversation_id,
        callerId,
      )
      if (deletedCheck?.kind === 'gone') {
        throw new UploadError(
          'GROUP_DELETED',
          'Group has been deleted',
          410,
          deletedCheck.info as unknown as Record<string, unknown>,
        )
      }
      // Caller must currently be an active member (or former member of
      // a non-deleted group, in which case access is cut off). Matches
      // how the message fan-out treats them.
      const role = await getGroupParticipantRole(row.conversation_id, callerId)
      if (!role) return null
    } else if (row.recipient_id !== callerId) {
      // Direct attachment: only the declared recipient may download.
      return null
    }
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
