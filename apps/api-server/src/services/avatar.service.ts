import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { findAgentById, getSupabaseClient } from '@agentchat/db'
import { env } from '../env.js'
import { logger } from '../lib/logger.js'
import { avatarsWritten } from '../lib/metrics.js'

// ─── Public constants (exposed to routes + tests) ─────────────────────────

// Cap on raw upload bytes. Anything larger is rejected without touching
// sharp — we want to bound decode CPU and decompression-bomb risk before
// the pipeline starts. 5 MB comfortably covers phone-photo originals;
// anything larger is either already-processed HDR or malicious.
export const MAX_AVATAR_INPUT_BYTES = 5 * 1024 * 1024

// Decoded input must be at least this wide/tall in each axis. Below this
// you're not really uploading a photo — you're either a misfire (icon
// file) or a probe. 128 leaves room for square 128×128 identicons the
// user might legitimately upload while filtering out 1×1 pixels.
export const MIN_AVATAR_INPUT_DIMENSION = 128

// Output target. 512 is the standard WhatsApp/Telegram avatar size —
// large enough to look crisp on retina profile pages, small enough that
// the processed file stays under ~100 KB. Single resolution keeps the
// key format + CDN story simple; if we ever need @2x we add a suffix.
export const AVATAR_OUTPUT_SIZE = 512

// WebP quality. 85 is the sweet spot from Google's own WebP guidance —
// visually lossless against JPEG quality 90 but ~25% smaller. Nothing
// above 90 is worth it for avatars.
const AVATAR_WEBP_QUALITY = 85

// First N hex chars of sha256(processed bytes). 32 hex = 128 bits of
// entropy, enough to make key collisions statistically impossible even
// across the entire agent population forever; 64 would be wasted URL
// length. 16 would be plenty too, but 32 gives us the same feel as short
// git commit hashes without being so short it invites accidental prefix
// collisions in logs.
const CONTENT_HASH_HEX_LEN = 32

// First N hex chars of sha256(agent_id). We use this — NOT the raw
// agent_id — as the storage-key directory so that the public CDN URL
// doesn't leak internal row ids onto the wire. The URL looks like
// .../avatars/{agent_prefix}/{content_hash}.webp; neither segment is
// reversible to the agent's UUID. 16 hex = 64 bits, which is ample
// partitioning for storage (2^64 slots) and gives pre-image resistance
// for a secret that isn't high-entropy to begin with (UUIDv4 is 122 bits
// — sha256-truncated to 64 still costs 2^32 work to brute force the
// UUID from the prefix, and learning the UUID gains an attacker
// nothing since we never accept it as a credential).
const AGENT_KEY_PREFIX_HEX_LEN = 16

/**
 * Deterministic per-agent storage-key prefix. Derived so identical
 * uploads from the same agent collide on the same key (idempotent
 * upsert) without exposing the agent's row id via the public URL.
 *
 * Exposed for unit tests; callers should prefer setAgentAvatar.
 */
export function deriveAgentKeyPrefix(agentId: string): string {
  return createHash('sha256').update(agentId).digest('hex').slice(0, AGENT_KEY_PREFIX_HEX_LEN)
}

/**
 * Deterministic per-group storage-key prefix. The leading "g/" sentinel
 * separates group keys from agent keys in the same bucket so a future
 * cleanup job (orphaned-byte sweeper, per-tenant deletion) can target one
 * or the other unambiguously. Same pre-image-resistance reasoning as the
 * agent variant — the public CDN URL never surfaces the raw conversation
 * UUID.
 */
export function deriveGroupKeyPrefix(groupId: string): string {
  const hash = createHash('sha256').update(groupId).digest('hex').slice(0, AGENT_KEY_PREFIX_HEX_LEN)
  return `g/${hash}`
}

// Bound sharp's decoded-pixel ceiling. Default is 268 million (≈1 GB
// RAM per decode at 4 bytes/pixel), acceptable for a photo-editing
// service but massive overkill for avatars. 24 MP covers a 6000×4000
// camera-native image (24-megapixel DSLR / phone main cameras) with
// ~96 MB peak decode memory — plenty for any legitimate avatar while
// giving us a much tighter ceiling on decompression-bomb amplification.
const AVATAR_MAX_INPUT_PIXELS = 24 * 1024 * 1024

// ─── Error class ─────────────────────────────────────────────────────────

export class AvatarError extends Error {
  code: string
  status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'AvatarError'
    this.code = code
    this.status = status
  }
}

// One-shot reject helper mirroring the rejectMute pattern in mute.service.ts.
// Bumps the rejected counter with the reason code so dashboards can see
// which validation path is firing without grepping logs.
function rejectAvatar(code: string, message: string, status: number): never {
  avatarsWritten.inc({ outcome: 'rejected', code })
  throw new AvatarError(code, message, status)
}

// ─── Magic-byte sniff ─────────────────────────────────────────────────────
//
// We don't trust the multipart `Content-Type` header — a client can send
// an arbitrary value, and accepting it at face value means executing
// sharp on non-image bytes (which is still safe, sharp rejects them, but
// leaks a misleading error code). Sniffing the first bytes gives us an
// authoritative format determination AND lets us reject non-image bodies
// with a precise error before spending decode CPU.

type SupportedFormat = 'jpeg' | 'png' | 'webp' | 'gif'

function sniffFormat(buf: Buffer): SupportedFormat | null {
  if (buf.length < 12) return null

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg'

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'png'
  }

  // WebP: "RIFF" .... "WEBP"
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'webp'
  }

  // GIF: "GIF87a" or "GIF89a"
  if (
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  ) {
    return 'gif'
  }

  return null
}

// ─── Image processing ────────────────────────────────────────────────────

export interface ProcessedAvatar {
  bytes: Buffer
  contentHash: string
  /** Declared input format, sniffed from magic bytes. For logs only. */
  sourceFormat: SupportedFormat
}

/**
 * Run the full pipeline on a raw upload buffer:
 *   1. Reject oversized inputs (5 MB cap) before touching sharp.
 *   2. Sniff magic bytes to confirm it's a supported image format.
 *   3. Decode with sharp, auto-orient from EXIF, read dimensions.
 *   4. Reject tiny inputs (< 128px on either axis).
 *   5. Center-crop to square and resize to 512×512 WebP @ q85.
 *   6. Re-encode strips ALL metadata (EXIF, GPS, thumbnails, ICC).
 *   7. Hash the output bytes → content hash for the storage key.
 *
 * Pure function — no I/O, no DB. Exposed for unit testing; the route
 * layer calls setAgentAvatar which wraps this with storage + DB writes.
 *
 * Throws AvatarError on any validation or decode failure. The route
 * handler maps (code, status) to HTTP uniformly.
 */
export async function processAvatarImage(input: Buffer): Promise<ProcessedAvatar> {
  if (input.length === 0) {
    rejectAvatar('EMPTY_BODY', 'Avatar upload is empty', 400)
  }
  if (input.length > MAX_AVATAR_INPUT_BYTES) {
    rejectAvatar(
      'PAYLOAD_TOO_LARGE',
      `Avatar exceeds the ${Math.floor(MAX_AVATAR_INPUT_BYTES / 1024 / 1024)} MB cap`,
      413,
    )
  }

  const sourceFormat = sniffFormat(input)
  if (!sourceFormat) {
    rejectAvatar(
      'UNSUPPORTED_FORMAT',
      'Avatar must be a JPEG, PNG, WebP, or GIF image',
      400,
    )
  }

  // `failOn: 'truncated'` tightens sharp's tolerance: a half-complete
  // JPEG is rejected here instead of producing a visibly broken avatar.
  // `limitInputPixels` tightens sharp's default decoded-pixel ceiling
  // (268 M px ≈ 1 GB RAM at 4 bytes/px) down to 24 MP ≈ 96 MB — enough
  // for a 24-megapixel phone photo, nowhere near a decompression bomb.
  let pipeline: sharp.Sharp
  try {
    pipeline = sharp(input, {
      failOn: 'truncated',
      limitInputPixels: AVATAR_MAX_INPUT_PIXELS,
    })
  } catch (e) {
    rejectAvatar('DECODE_FAILED', `Could not decode image: ${(e as Error).message}`, 400)
  }

  let metadata: sharp.Metadata
  try {
    metadata = await pipeline.metadata()
  } catch (e) {
    rejectAvatar('DECODE_FAILED', `Could not read image metadata: ${(e as Error).message}`, 400)
  }

  const { width, height } = metadata
  if (!width || !height) {
    rejectAvatar('DECODE_FAILED', 'Image has missing or zero dimensions', 400)
  }
  if (width < MIN_AVATAR_INPUT_DIMENSION || height < MIN_AVATAR_INPUT_DIMENSION) {
    rejectAvatar(
      'IMAGE_TOO_SMALL',
      `Avatar must be at least ${MIN_AVATAR_INPUT_DIMENSION}px on each side (got ${width}×${height})`,
      400,
    )
  }

  // `.rotate()` with no args applies the EXIF orientation and then drops
  // the EXIF tag, so portraits taken on phones don't land sideways after
  // re-encode. It MUST come before resize — if we resize first, the final
  // WebP inherits the wrong aspect.
  //
  // `.resize(512, 512, { fit: 'cover' })` is the center-crop-and-fill
  // behaviour we want: it scales the shortest axis to 512 and crops the
  // overflow on the longer axis. `fit: 'contain'` would letterbox, which
  // looks terrible for avatars. Explicit `position: 'center'` makes the
  // default obvious even if sharp's default ever changes.
  //
  // `.webp({ quality: 85, effort: 4 })` — effort=4 is sharp's default;
  // higher gives slightly smaller files but multiplies encode time.
  // Avatars are encoded once and read millions of times, so in principle
  // effort=6 makes sense — but the CPU cost on the request path isn't
  // worth the ~5% size win when we're already writing to a CDN.
  let processed: Buffer
  try {
    processed = await pipeline
      .rotate()
      .resize(AVATAR_OUTPUT_SIZE, AVATAR_OUTPUT_SIZE, {
        fit: 'cover',
        position: 'center',
      })
      .webp({ quality: AVATAR_WEBP_QUALITY, effort: 4 })
      .toBuffer()
  } catch (e) {
    rejectAvatar('PROCESSING_FAILED', `Image processing failed: ${(e as Error).message}`, 400)
  }

  const contentHash = createHash('sha256')
    .update(processed)
    .digest('hex')
    .slice(0, CONTENT_HASH_HEX_LEN)

  return { bytes: processed, contentHash, sourceFormat }
}

// ─── URL assembly ─────────────────────────────────────────────────────────

/**
 * Build the public CDN URL for a stored avatar. Format:
 *   {SUPABASE_URL}/storage/v1/object/public/{bucket}/{key}
 *
 * Returns null on null input (the "no avatar" state). Callers pass this
 * through to the wire directly — it's the value of `avatar_url` in every
 * agent response.
 *
 * Stable across rotations because the URL embeds the content hash via the
 * key, so a fresh upload gets a fresh URL and CDN caches invalidate
 * themselves without us needing to manage busting.
 */
export function buildAvatarUrl(avatarKey: string | null | undefined): string | null {
  if (!avatarKey) return null
  const base = env.SUPABASE_URL.replace(/\/+$/, '')
  return `${base}/storage/v1/object/public/${env.AVATARS_BUCKET}/${avatarKey}`
}

// ─── Storage writes ───────────────────────────────────────────────────────

export interface SetAvatarResult {
  avatar_key: string
  avatar_url: string
}

/**
 * Upload + persist an avatar.
 *
 * Order of operations, chosen to minimize orphaned rows / orphaned bytes:
 *   1. Validate the agent is alive (readable, not deleted).
 *   2. Process the image (no I/O beyond CPU).
 *   3. Upload the processed bytes to storage with upsert=true.
 *   4. Update agents.avatar_key.
 *   5. Best-effort delete the PRIOR avatar's bytes (if different).
 *
 * Storage-before-row is deliberate: if the upload succeeds but the DB
 * update fails, the bucket has an orphaned object. No sweeper exists
 * yet, so these orphans accumulate — at avatar-sized WebPs (~50 KB)
 * the leak is small enough to defer the cleanup job. Row-before-storage
 * would risk the opposite — a row pointing at nothing — which clients
 * would observe as broken 404 avatar URLs.
 *
 * If the caller uploads the same image twice, the content hash is
 * identical, the key is identical, the storage upsert is a no-op, and
 * the row update is a no-op. That's the correct idempotent behavior.
 */
export async function setAgentAvatar(
  agentId: string,
  input: Buffer,
): Promise<SetAvatarResult> {
  const agent = await findAgentById(agentId)
  if (!agent || agent.status === 'deleted') {
    rejectAvatar('AGENT_NOT_FOUND', 'Account not found', 404)
  }
  if (agent.status === 'suspended') {
    rejectAvatar('FORBIDDEN', 'Cannot update a suspended account', 403)
  }

  const processed = await processAvatarImage(input)
  // Derive a non-reversible directory from the agent id so the public
  // CDN URL never surfaces the raw UUID. See deriveAgentKeyPrefix.
  const newKey = `${deriveAgentKeyPrefix(agentId)}/${processed.contentHash}.webp`
  const priorKey: string | null = (agent.avatar_key as string | null | undefined) ?? null

  const storage = getSupabaseClient().storage.from(env.AVATARS_BUCKET)

  // upsert=true: the same content hash produces the same key, and an
  // identical re-upload should be a success no-op. contentType is set
  // explicitly because Supabase Storage sniffs from file extension but
  // we're being explicit — the bucket will serve with this header and
  // the CDN will cache it by it.
  const { error: uploadError } = await storage.upload(newKey, processed.bytes, {
    contentType: 'image/webp',
    upsert: true,
    cacheControl: 'public, max-age=31536000, immutable',
  })

  if (uploadError) {
    avatarsWritten.inc({ outcome: 'storage_error' })
    logger.error(
      { agent_id: agentId, key: newKey, error: uploadError.message },
      'avatar_upload_failed',
    )
    throw new AvatarError(
      'STORAGE_UNAVAILABLE',
      'Storage backend could not accept the avatar upload',
      503,
    )
  }

  const { error: updateError } = await getSupabaseClient()
    .from('agents')
    .update({ avatar_key: newKey })
    .eq('id', agentId)

  if (updateError) {
    // Row update failed after storage write succeeded. We leave the
    // storage object in place — it'll be reaped by the nightly cleanup
    // (or overwritten on the user's retry). Surface the DB error as
    // INTERNAL so we don't leak implementation details to the client.
    avatarsWritten.inc({ outcome: 'storage_error' })
    logger.error(
      { agent_id: agentId, key: newKey, error: updateError.message },
      'avatar_row_update_failed',
    )
    throw new AvatarError(
      'INTERNAL_ERROR',
      'Failed to persist avatar reference',
      500,
    )
  }

  // Best-effort delete the prior object if the key changed. A failure
  // here doesn't block the request — we'd rather leave a few KB of
  // orphaned bytes than make the user retry because cleanup failed.
  // No sweeper runs yet, so those orphans accumulate until one lands.
  if (priorKey && priorKey !== newKey) {
    void storage.remove([priorKey]).catch((err) => {
      logger.warn(
        { agent_id: agentId, prior_key: priorKey, error: (err as Error).message },
        'avatar_prior_delete_failed',
      )
    })
  }

  avatarsWritten.inc({ outcome: 'uploaded' })
  logger.info(
    {
      agent_id: agentId,
      key: newKey,
      source_format: processed.sourceFormat,
      processed_bytes: processed.bytes.length,
    },
    'avatar_uploaded',
  )

  return { avatar_key: newKey, avatar_url: buildAvatarUrl(newKey)! }
}

// ─── Boot-time bucket probe ───────────────────────────────────────────────
//
// On startup we do a cheap list() against the configured avatar bucket so
// the operator sees a loud log line the moment the server boots with a
// misconfigured storage backend — instead of finding out hours later from
// the first user's 503. We do NOT exit the process: a flaky probe should
// not kill a server whose other routes are healthy, and a genuine
// misconfig still surfaces loudly at request time as a 503 with the same
// error code. This is informational hardening, not a gate.
//
// Returns `true` when the bucket is reachable AND public (storage returns
// a valid list), `false` on any error. Call from index.ts once at boot.
export async function verifyAvatarBucket(): Promise<boolean> {
  try {
    const { error } = await getSupabaseClient()
      .storage.from(env.AVATARS_BUCKET)
      .list('', { limit: 1 })
    if (error) {
      logger.error(
        { bucket: env.AVATARS_BUCKET, error: error.message },
        'avatar_bucket_probe_failed',
      )
      return false
    }
    logger.info({ bucket: env.AVATARS_BUCKET }, 'avatar_bucket_ready')
    return true
  } catch (e) {
    logger.error(
      { bucket: env.AVATARS_BUCKET, error: (e as Error).message },
      'avatar_bucket_probe_threw',
    )
    return false
  }
}

/**
 * Remove an avatar. Clears the DB column first, then best-effort deletes
 * the bytes. The order matters: if storage delete fails, we've still
 * removed the visible avatar (the URL 404s cleanly rather than serving
 * a ghost image). If the DB update fails, we bail without touching
 * storage so retry is safe.
 *
 * Returns `{ existed: false }` when the agent had no avatar to begin
 * with — route layer turns that into a 404 so clients can detect
 * double-deletes the same way they do for mute-removes.
 */
export async function removeAgentAvatar(agentId: string): Promise<{ existed: boolean }> {
  const agent = await findAgentById(agentId)
  if (!agent || agent.status === 'deleted') {
    rejectAvatar('AGENT_NOT_FOUND', 'Account not found', 404)
  }
  if (agent.status === 'suspended') {
    rejectAvatar('FORBIDDEN', 'Cannot update a suspended account', 403)
  }

  const priorKey: string | null = (agent.avatar_key as string | null | undefined) ?? null
  if (!priorKey) return { existed: false }

  const { error: updateError } = await getSupabaseClient()
    .from('agents')
    .update({ avatar_key: null })
    .eq('id', agentId)

  if (updateError) {
    logger.error(
      { agent_id: agentId, error: updateError.message },
      'avatar_row_clear_failed',
    )
    throw new AvatarError(
      'INTERNAL_ERROR',
      'Failed to clear avatar reference',
      500,
    )
  }

  // Best-effort delete the bytes. Same rationale as the setAgentAvatar
  // cleanup path — a failure here is just orphaned bytes, not broken UX.
  void getSupabaseClient()
    .storage.from(env.AVATARS_BUCKET)
    .remove([priorKey])
    .catch((err) => {
      logger.warn(
        { agent_id: agentId, prior_key: priorKey, error: (err as Error).message },
        'avatar_delete_bytes_failed',
      )
    })

  avatarsWritten.inc({ outcome: 'removed' })
  logger.info({ agent_id: agentId, prior_key: priorKey }, 'avatar_removed')
  return { existed: true }
}
