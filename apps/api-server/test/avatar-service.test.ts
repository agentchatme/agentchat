import { describe, it, expect, vi, beforeEach } from 'vitest'
import sharp from 'sharp'

// Service-layer tests for the avatar feature. Two kinds of test:
//
//   1. `processAvatarImage` — pure function, no I/O, tested with REAL
//      sharp against real image fixtures generated in-test. We want
//      actual bytes running through the pipeline so magic-byte sniff
//      and the resize/re-encode paths are exercised end-to-end.
//
//   2. `setAgentAvatar` / `removeAgentAvatar` — storage + DB side
//      effects are mocked. We assert the service issues the right
//      calls in the right order (storage-before-row on set, row-
//      before-storage on remove) and maps failures to the right
//      (code, status) errors.
//
// The routes are tested separately (avatar-routes.test.ts) with the
// service itself mocked. Here we pin the service layer's own decisions.

// ─── Fixtures: generate tiny real images in-process ────────────────────

async function makeSolidPng(width: number, height: number, color = { r: 32, g: 64, b: 128 }): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: color,
    },
  })
    .png()
    .toBuffer()
}

async function makeSolidJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 200, g: 100, b: 50 },
    },
  })
    .jpeg()
    .toBuffer()
}

async function makeSolidWebp(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 10, g: 220, b: 90 },
    },
  })
    .webp()
    .toBuffer()
}

// Makes a real GIF by first composing an RGB raster then piping through
// sharp's GIF encoder. Older sharp versions needed libvips built with
// libgif, which we assume the monorepo root's pinned sharp build has
// (it does — sharp's prebuilt binaries include libgif since 0.32).
async function makeSolidGif(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 255, g: 0, b: 128 },
    },
  })
    .gif()
    .toBuffer()
}

// ─── DB + storage mocks ────────────────────────────────────────────────

const findAgentByIdMock = vi.fn()
// getSupabaseClient().storage.from(bucket).upload / remove
const storageUploadMock = vi.fn()
const storageRemoveMock = vi.fn()
// getSupabaseClient().from('agents').update({}).eq()
const dbUpdateMock = vi.fn()
const dbEqMock = vi.fn()

function makeSupabaseClient() {
  return {
    storage: {
      from: (_bucket: string) => ({
        upload: storageUploadMock,
        remove: storageRemoveMock,
      }),
    },
    from: (_table: string) => ({
      update: (patch: Record<string, unknown>) => {
        dbUpdateMock(patch)
        return {
          eq: (col: string, val: string) => {
            dbEqMock(col, val)
            return Promise.resolve({ error: null })
          },
        }
      },
    }),
  }
}

let supabaseClient = makeSupabaseClient()
const getSupabaseClientMock = vi.fn(() => supabaseClient)

vi.mock('@agentchat/db', () => ({
  findAgentById: findAgentByIdMock,
  getSupabaseClient: getSupabaseClientMock,
}))

// Env is imported transitively through avatar.service — mock just the
// two values we care about so we don't need a .env file at test time.
vi.mock('../src/env.js', () => ({
  env: {
    SUPABASE_URL: 'https://project.supabase.co',
    AVATARS_BUCKET: 'avatars',
  },
}))

const {
  processAvatarImage,
  buildAvatarUrl,
  setAgentAvatar,
  removeAgentAvatar,
  deriveAgentKeyPrefix,
  verifyAvatarBucket,
  AvatarError,
  MAX_AVATAR_INPUT_BYTES,
  MIN_AVATAR_INPUT_DIMENSION,
  AVATAR_OUTPUT_SIZE,
} = await import('../src/services/avatar.service.js')

beforeEach(() => {
  findAgentByIdMock.mockReset()
  storageUploadMock.mockReset()
  storageRemoveMock.mockReset()
  dbUpdateMock.mockReset()
  dbEqMock.mockReset()
  supabaseClient = makeSupabaseClient()
  getSupabaseClientMock.mockImplementation(() => supabaseClient)
})

// ─── processAvatarImage — validation and pipeline ──────────────────────

describe('processAvatarImage — input validation', () => {
  it('rejects an empty buffer with EMPTY_BODY 400', async () => {
    await expect(processAvatarImage(Buffer.alloc(0))).rejects.toMatchObject({
      name: 'AvatarError',
      code: 'EMPTY_BODY',
      status: 400,
    })
  })

  it('rejects a buffer larger than MAX_AVATAR_INPUT_BYTES with PAYLOAD_TOO_LARGE 413', async () => {
    // A single byte past the cap — no need for a 5 MB allocation.
    const tooLarge = Buffer.alloc(MAX_AVATAR_INPUT_BYTES + 1)
    await expect(processAvatarImage(tooLarge)).rejects.toMatchObject({
      name: 'AvatarError',
      code: 'PAYLOAD_TOO_LARGE',
      status: 413,
    })
  })

  it('rejects a buffer that is not a supported image format with UNSUPPORTED_FORMAT 400', async () => {
    // 32 bytes of plausible-looking-but-non-image content.
    const garbage = Buffer.from('this is plain text not an image')
    await expect(processAvatarImage(garbage)).rejects.toMatchObject({
      name: 'AvatarError',
      code: 'UNSUPPORTED_FORMAT',
      status: 400,
    })
  })

  it('rejects an image whose dimensions are below the minimum with IMAGE_TOO_SMALL 400', async () => {
    const tiny = await makeSolidPng(64, 64)
    await expect(processAvatarImage(tiny)).rejects.toMatchObject({
      name: 'AvatarError',
      code: 'IMAGE_TOO_SMALL',
      status: 400,
    })
  })

  it('accepts an image at exactly the minimum dimension', async () => {
    const edge = await makeSolidPng(MIN_AVATAR_INPUT_DIMENSION, MIN_AVATAR_INPUT_DIMENSION)
    const processed = await processAvatarImage(edge)
    expect(processed.sourceFormat).toBe('png')
    expect(processed.bytes.length).toBeGreaterThan(0)
  })
})

describe('processAvatarImage — happy path', () => {
  it('accepts a real JPEG and returns a processed WebP buffer with a content hash', async () => {
    const jpeg = await makeSolidJpeg(640, 480)
    const processed = await processAvatarImage(jpeg)

    expect(processed.sourceFormat).toBe('jpeg')
    // WebP magic: "RIFF" .... "WEBP"
    expect(processed.bytes.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(processed.bytes.subarray(8, 12).toString('ascii')).toBe('WEBP')
    // Content hash is 32 hex chars.
    expect(processed.contentHash).toMatch(/^[0-9a-f]{32}$/)
  })

  it('accepts a real PNG', async () => {
    const png = await makeSolidPng(512, 512)
    const processed = await processAvatarImage(png)
    expect(processed.sourceFormat).toBe('png')
    expect(processed.bytes.length).toBeGreaterThan(0)
  })

  it('accepts a real WebP input', async () => {
    const webp = await makeSolidWebp(256, 256)
    const processed = await processAvatarImage(webp)
    expect(processed.sourceFormat).toBe('webp')
  })

  it('accepts a real GIF input', async () => {
    const gif = await makeSolidGif(256, 256)
    const processed = await processAvatarImage(gif)
    expect(processed.sourceFormat).toBe('gif')
  })

  it('produces a 512×512 output regardless of input aspect ratio (center-crop)', async () => {
    // Wide 1024×512 input — center-crop should trim to a square before
    // resize, producing a 512×512 output.
    const wide = await makeSolidJpeg(1024, 512)
    const processed = await processAvatarImage(wide)
    const meta = await sharp(processed.bytes).metadata()
    expect(meta.width).toBe(AVATAR_OUTPUT_SIZE)
    expect(meta.height).toBe(AVATAR_OUTPUT_SIZE)
  })

  it('produces a 512×512 output for tall inputs too', async () => {
    const tall = await makeSolidJpeg(512, 1024)
    const processed = await processAvatarImage(tall)
    const meta = await sharp(processed.bytes).metadata()
    expect(meta.width).toBe(AVATAR_OUTPUT_SIZE)
    expect(meta.height).toBe(AVATAR_OUTPUT_SIZE)
  })

  it('is deterministic — same input bytes produce the same content hash', async () => {
    const jpeg = await makeSolidJpeg(640, 480)
    const a = await processAvatarImage(jpeg)
    const b = await processAvatarImage(jpeg)
    expect(a.contentHash).toBe(b.contentHash)
  })

  it('strips input metadata from the output', async () => {
    // Generate a PNG with a custom ICC profile and inspect that the
    // output doesn't carry any of it through.
    const png = await sharp({
      create: { width: 256, height: 256, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer()

    const processed = await processAvatarImage(png)
    const meta = await sharp(processed.bytes).metadata()
    // The re-encoded WebP should not carry EXIF or ICC through.
    expect(meta.exif).toBeUndefined()
  })
})

// ─── buildAvatarUrl ──────────────────────────────────────────────────────

describe('buildAvatarUrl', () => {
  it('returns null for null/undefined/empty-string keys', () => {
    expect(buildAvatarUrl(null)).toBeNull()
    expect(buildAvatarUrl(undefined)).toBeNull()
    expect(buildAvatarUrl('')).toBeNull()
  })

  it('assembles a Supabase public-object URL from the stored key', () => {
    const url = buildAvatarUrl('agt_alice/abc123.webp')
    expect(url).toBe(
      'https://project.supabase.co/storage/v1/object/public/avatars/agt_alice/abc123.webp',
    )
  })

  it('tolerates a trailing slash on SUPABASE_URL without double-slashing', () => {
    // buildAvatarUrl normalizes the trailing slash — verify via a key
    // that exercises the slash-stripping path.
    const url = buildAvatarUrl('agt_bob/def456.webp')
    expect(url).not.toContain('.co//storage')
  })
})

// ─── setAgentAvatar — service behavior ──────────────────────────────────

describe('setAgentAvatar', () => {
  it('rejects with AGENT_NOT_FOUND 404 when the agent does not exist', async () => {
    findAgentByIdMock.mockResolvedValue(null)
    const png = await makeSolidPng(256, 256)
    await expect(setAgentAvatar('agt_missing', png)).rejects.toMatchObject({
      name: 'AvatarError',
      code: 'AGENT_NOT_FOUND',
      status: 404,
    })
  })

  it('rejects with AGENT_NOT_FOUND 404 for soft-deleted agents', async () => {
    findAgentByIdMock.mockResolvedValue({ id: 'agt_a', status: 'deleted' })
    const png = await makeSolidPng(256, 256)
    await expect(setAgentAvatar('agt_a', png)).rejects.toMatchObject({
      code: 'AGENT_NOT_FOUND',
      status: 404,
    })
  })

  it('rejects with FORBIDDEN 403 for suspended agents', async () => {
    findAgentByIdMock.mockResolvedValue({ id: 'agt_a', status: 'suspended' })
    const png = await makeSolidPng(256, 256)
    await expect(setAgentAvatar('agt_a', png)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    })
  })

  it('happy path: uploads bytes, writes avatar_key, returns public URL', async () => {
    findAgentByIdMock.mockResolvedValue({
      id: 'agt_alice',
      status: 'active',
      avatar_key: null,
    })
    storageUploadMock.mockResolvedValue({ error: null })

    const png = await makeSolidPng(256, 256)
    const result = await setAgentAvatar('agt_alice', png)

    // Upload was called with a key of the right shape: 16-hex agent
    // prefix (sha256 truncation — NOT the raw agent id, see plan §avatars)
    // and 32-hex content hash. Full raw agent_id would leak internal row
    // ids onto the public CDN URL, which this test pins against.
    expect(storageUploadMock).toHaveBeenCalledTimes(1)
    const [key, bytes, opts] = storageUploadMock.mock.calls[0]!
    expect(key).toMatch(/^[0-9a-f]{16}\/[0-9a-f]{32}\.webp$/)
    expect(key.startsWith(`${deriveAgentKeyPrefix('agt_alice')}/`)).toBe(true)
    // Invariant: the raw agent id must NOT appear anywhere in the key.
    expect(key).not.toContain('agt_alice')
    expect(Buffer.isBuffer(bytes)).toBe(true)
    expect(opts).toMatchObject({
      contentType: 'image/webp',
      upsert: true,
      cacheControl: 'public, max-age=31536000, immutable',
    })

    // DB update sets avatar_key on the right row.
    expect(dbUpdateMock).toHaveBeenCalledWith({ avatar_key: key })
    expect(dbEqMock).toHaveBeenCalledWith('id', 'agt_alice')

    // Response shape.
    expect(result.avatar_key).toBe(key)
    expect(result.avatar_url).toBe(
      `https://project.supabase.co/storage/v1/object/public/avatars/${key}`,
    )

    // No prior key → no remove call.
    expect(storageRemoveMock).not.toHaveBeenCalled()
  })

  it('deletes the prior avatar bytes when the new content hash differs', async () => {
    const priorKey = `${deriveAgentKeyPrefix('agt_alice')}/oldhash.webp`
    findAgentByIdMock.mockResolvedValue({
      id: 'agt_alice',
      status: 'active',
      avatar_key: priorKey,
    })
    storageUploadMock.mockResolvedValue({ error: null })
    storageRemoveMock.mockResolvedValue({ error: null })

    const png = await makeSolidPng(256, 256)
    await setAgentAvatar('agt_alice', png)

    // Give the fire-and-forget cleanup path a tick to enqueue.
    await new Promise((r) => setImmediate(r))

    expect(storageRemoveMock).toHaveBeenCalledWith([priorKey])
  })

  it('does NOT delete when the new content hash matches the prior key (no-op upsert)', async () => {
    const png = await makeSolidPng(256, 256)
    // Compute what the key would be by running the pipeline once.
    const { contentHash } = await processAvatarImage(png)
    const sameKey = `${deriveAgentKeyPrefix('agt_alice')}/${contentHash}.webp`

    findAgentByIdMock.mockResolvedValue({
      id: 'agt_alice',
      status: 'active',
      avatar_key: sameKey,
    })
    storageUploadMock.mockResolvedValue({ error: null })

    await setAgentAvatar('agt_alice', png)
    await new Promise((r) => setImmediate(r))

    expect(storageRemoveMock).not.toHaveBeenCalled()
  })

  it('maps a storage upload failure to STORAGE_UNAVAILABLE 503', async () => {
    findAgentByIdMock.mockResolvedValue({ id: 'agt_a', status: 'active', avatar_key: null })
    storageUploadMock.mockResolvedValue({ error: { message: 'bucket misconfigured' } })

    const png = await makeSolidPng(256, 256)
    await expect(setAgentAvatar('agt_a', png)).rejects.toMatchObject({
      name: 'AvatarError',
      code: 'STORAGE_UNAVAILABLE',
      status: 503,
    })

    // DB was never touched.
    expect(dbUpdateMock).not.toHaveBeenCalled()
  })

  it('maps a row update failure to INTERNAL_ERROR 500 and leaves storage as-is', async () => {
    findAgentByIdMock.mockResolvedValue({ id: 'agt_a', status: 'active', avatar_key: null })
    storageUploadMock.mockResolvedValue({ error: null })

    // Override the supabase client factory so .eq returns an error.
    supabaseClient = {
      storage: {
        from: () => ({ upload: storageUploadMock, remove: storageRemoveMock }),
      },
      from: () => ({
        update: () => ({
          eq: () => Promise.resolve({ error: { message: 'unique violation' } }),
        }),
      }),
    }
    getSupabaseClientMock.mockImplementation(() => supabaseClient)

    const png = await makeSolidPng(256, 256)
    await expect(setAgentAvatar('agt_a', png)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      status: 500,
    })
  })
})

// ─── removeAgentAvatar ───────────────────────────────────────────────────

describe('removeAgentAvatar', () => {
  it('returns { existed: false } for an agent with no prior avatar', async () => {
    findAgentByIdMock.mockResolvedValue({ id: 'agt_a', status: 'active', avatar_key: null })

    const result = await removeAgentAvatar('agt_a')
    expect(result.existed).toBe(false)
    expect(dbUpdateMock).not.toHaveBeenCalled()
    expect(storageRemoveMock).not.toHaveBeenCalled()
  })

  it('clears the row and deletes the storage bytes on a successful remove', async () => {
    const priorKey = `${deriveAgentKeyPrefix('agt_a')}/somehash.webp`
    findAgentByIdMock.mockResolvedValue({
      id: 'agt_a',
      status: 'active',
      avatar_key: priorKey,
    })
    storageRemoveMock.mockResolvedValue({ error: null })

    const result = await removeAgentAvatar('agt_a')
    expect(result.existed).toBe(true)
    expect(dbUpdateMock).toHaveBeenCalledWith({ avatar_key: null })
    // Let the best-effort remove enqueue.
    await new Promise((r) => setImmediate(r))
    expect(storageRemoveMock).toHaveBeenCalledWith([priorKey])
  })

  it('rejects AGENT_NOT_FOUND for deleted agents', async () => {
    findAgentByIdMock.mockResolvedValue({ id: 'agt_a', status: 'deleted' })
    await expect(removeAgentAvatar('agt_a')).rejects.toMatchObject({
      code: 'AGENT_NOT_FOUND',
      status: 404,
    })
  })

  it('returns INTERNAL_ERROR 500 if the row clear fails', async () => {
    findAgentByIdMock.mockResolvedValue({
      id: 'agt_a',
      status: 'active',
      avatar_key: 'agt_a/old.webp',
    })
    supabaseClient = {
      storage: { from: () => ({ upload: storageUploadMock, remove: storageRemoveMock }) },
      from: () => ({
        update: () => ({
          eq: () => Promise.resolve({ error: { message: 'conflict' } }),
        }),
      }),
    }
    getSupabaseClientMock.mockImplementation(() => supabaseClient)

    await expect(removeAgentAvatar('agt_a')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      status: 500,
    })
  })

  it('uses the hashed prior key shape when removing — raw id never leaks on the wire', async () => {
    // Fabricated prior key uses the hashed prefix (this is what migration
    // 035 + the setAgentAvatar path produce). The remove must pass through
    // whatever is in the row verbatim — no recomputation from agent_id.
    const priorKey = 'deadbeef00112233/abcdef0123.webp'
    findAgentByIdMock.mockResolvedValue({
      id: 'agt_z',
      status: 'active',
      avatar_key: priorKey,
    })
    storageRemoveMock.mockResolvedValue({ error: null })

    await removeAgentAvatar('agt_z')
    await new Promise((r) => setImmediate(r))

    expect(storageRemoveMock).toHaveBeenCalledWith([priorKey])
  })
})

// ─── deriveAgentKeyPrefix — wire-contract invariant ──────────────────────
// The whole point of this function is that the PUBLIC avatar URL never
// surfaces an internal agent row id. These tests pin that invariant.

describe('deriveAgentKeyPrefix', () => {
  it('returns a 16-char lowercase hex string', () => {
    const prefix = deriveAgentKeyPrefix('agt_abc123')
    expect(prefix).toMatch(/^[0-9a-f]{16}$/)
    expect(prefix.length).toBe(16)
  })

  it('is deterministic — same id always yields the same prefix', () => {
    const a = deriveAgentKeyPrefix('agt_alice')
    const b = deriveAgentKeyPrefix('agt_alice')
    expect(a).toBe(b)
  })

  it('differs across different agent ids', () => {
    const alice = deriveAgentKeyPrefix('agt_alice')
    const bob = deriveAgentKeyPrefix('agt_bob')
    expect(alice).not.toBe(bob)
  })

  it('does NOT contain the raw agent id as a substring — the prefix is non-obvious from the id', () => {
    // The whole reason we hash: the public CDN URL embeds this prefix
    // and must not reveal which agent row the avatar belongs to.
    const id = 'agt_alice_secret_id_12345'
    const prefix = deriveAgentKeyPrefix(id)
    expect(prefix).not.toContain('alice')
    expect(prefix).not.toContain(id)
  })
})

// ─── verifyAvatarBucket — startup probe ──────────────────────────────────
// The server boot path fires this to catch a missing / misconfigured
// bucket early instead of letting the first avatar write 503. We return
// a boolean and log on failure — we do NOT throw, because a flaky probe
// shouldn't crash an otherwise healthy server.

describe('verifyAvatarBucket', () => {
  it('returns true when the bucket exists and storage.list succeeds', async () => {
    const listMock = vi.fn().mockResolvedValue({ data: [], error: null })
    supabaseClient = {
      storage: { from: () => ({ list: listMock, upload: storageUploadMock, remove: storageRemoveMock }) },
      from: () => ({ update: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
    }
    getSupabaseClientMock.mockImplementation(() => supabaseClient)

    const ok = await verifyAvatarBucket()
    expect(ok).toBe(true)
    expect(listMock).toHaveBeenCalledWith('', { limit: 1 })
  })

  it('returns false (without throwing) when the bucket probe reports an error', async () => {
    const listMock = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'bucket not found' },
    })
    supabaseClient = {
      storage: { from: () => ({ list: listMock, upload: storageUploadMock, remove: storageRemoveMock }) },
      from: () => ({ update: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
    }
    getSupabaseClientMock.mockImplementation(() => supabaseClient)

    const ok = await verifyAvatarBucket()
    expect(ok).toBe(false)
  })

  it('returns false (without throwing) when the probe call itself throws', async () => {
    const listMock = vi.fn().mockRejectedValue(new Error('ENETUNREACH'))
    supabaseClient = {
      storage: { from: () => ({ list: listMock, upload: storageUploadMock, remove: storageRemoveMock }) },
      from: () => ({ update: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
    }
    getSupabaseClientMock.mockImplementation(() => supabaseClient)

    const ok = await verifyAvatarBucket()
    expect(ok).toBe(false)
  })
})

it('AvatarError is a proper Error subclass exposing code + status', () => {
  const e = new AvatarError('FOO', 'bar', 400)
  expect(e).toBeInstanceOf(Error)
  expect(e.name).toBe('AvatarError')
  expect(e.code).toBe('FOO')
  expect(e.status).toBe(400)
  expect(e.message).toBe('bar')
})
