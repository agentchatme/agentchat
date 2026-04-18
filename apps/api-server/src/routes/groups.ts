import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import {
  CreateGroupRequest,
  UpdateGroupRequest,
  AddMemberRequest,
} from '@agentchat/shared'
import { authMiddleware } from '../middleware/auth.js'
import { idempotencyMiddleware } from '../middleware/idempotency.js'
import {
  createGroup,
  getGroup,
  updateGroup,
  addMemberToGroup,
  leaveGroup,
  kickMember,
  promoteAdmin,
  demoteAdmin,
  acceptInvite,
  rejectInvite,
  listInvites,
  deleteGroup,
  setGroupAvatar,
  removeGroupAvatar,
  GroupError,
} from '../services/group.service.js'
import { AvatarError, MAX_AVATAR_INPUT_BYTES } from '../services/avatar.service.js'
import { checkAvatarWriteRateLimit } from '../services/enforcement.service.js'
import { avatarsWritten, rateLimitHits } from '../lib/metrics.js'

const groups = new Hono()

function handleError(e: unknown) {
  if (e instanceof GroupError) {
    const body: Record<string, unknown> = { code: e.code, message: e.message }
    if (e.details) body.details = e.details
    return {
      body,
      status: e.status as 400 | 403 | 404 | 410 | 429,
    }
  }
  return null
}

// POST /v1/groups — Create a new group. Creator is auto-admin; any
// initial member handles are run through the same auto-add vs pending
// path as subsequent adds, so individual failures don't abort the whole
// create.
groups.post('/', authMiddleware, idempotencyMiddleware, async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }, 400)
  }
  const parsed = CreateGroupRequest.safeParse(body)
  if (!parsed.success) {
    return c.json(
      {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
        details: parsed.error.flatten(),
      },
      400,
    )
  }
  try {
    const agentId = c.get('agentId')
    const result = await createGroup(agentId, parsed.data)
    return c.json(result, 201)
  } catch (e) {
    const mapped = handleError(e)
    if (mapped) return c.json(mapped.body, mapped.status)
    throw e
  }
})

// GET /v1/groups/invites — Pending invites for the caller. Must come
// before /:id to avoid the :id param swallowing the 'invites' literal.
groups.get('/invites', authMiddleware, async (c) => {
  const agentId = c.get('agentId')
  const invites = await listInvites(agentId)
  return c.json(invites)
})

// POST /v1/groups/invites/:invite_id/accept — Accept a pending invite.
// Server-side verification: the RPC enforces that the caller owns the
// invite row, so a guessed/leaked invite id can't be used by a stranger.
groups.post('/invites/:invite_id/accept', authMiddleware, idempotencyMiddleware, async (c) => {
  const inviteId = c.req.param('invite_id')
  try {
    const agentId = c.get('agentId')
    const group = await acceptInvite(agentId, inviteId)
    return c.json(group)
  } catch (e) {
    const mapped = handleError(e)
    if (mapped) return c.json(mapped.body, mapped.status)
    throw e
  }
})

// DELETE /v1/groups/invites/:invite_id — Reject / discard a pending invite.
groups.delete('/invites/:invite_id', authMiddleware, async (c) => {
  const inviteId = c.req.param('invite_id')
  try {
    const agentId = c.get('agentId')
    await rejectInvite(agentId, inviteId)
    return c.json({ message: 'Invite rejected' })
  } catch (e) {
    const mapped = handleError(e)
    if (mapped) return c.json(mapped.body, mapped.status)
    throw e
  }
})

// GET /v1/groups/:id — Group detail including the member list and the
// caller's own role. Non-members get 404 (existence is masked).
groups.get('/:id', authMiddleware, async (c) => {
  const groupId = c.req.param('id')
  try {
    const agentId = c.get('agentId')
    const detail = await getGroup(agentId, groupId)
    return c.json(detail)
  } catch (e) {
    const mapped = handleError(e)
    if (mapped) return c.json(mapped.body, mapped.status)
    throw e
  }
})

// PATCH /v1/groups/:id — Update group metadata (admin-only). Emits one
// system message per changed field so the timeline shows discrete events.
groups.patch('/:id', authMiddleware, idempotencyMiddleware, async (c) => {
  const groupId = c.req.param('id')
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }, 400)
  }
  const parsed = UpdateGroupRequest.safeParse(body)
  if (!parsed.success) {
    return c.json(
      {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
        details: parsed.error.flatten(),
      },
      400,
    )
  }
  try {
    const agentId = c.get('agentId')
    const updated = await updateGroup(agentId, groupId, parsed.data)
    return c.json(updated)
  } catch (e) {
    const mapped = handleError(e)
    if (mapped) return c.json(mapped.body, mapped.status)
    throw e
  }
})

// POST /v1/groups/:id/members — Add a single member (admin-only). The
// response carries per-handle outcome so the SDK can show "joined" vs
// "invited" without a second round-trip.
groups.post('/:id/members', authMiddleware, idempotencyMiddleware, async (c) => {
  const groupId = c.req.param('id')
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }, 400)
  }
  const parsed = AddMemberRequest.safeParse(body)
  if (!parsed.success) {
    return c.json(
      {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
        details: parsed.error.flatten(),
      },
      400,
    )
  }
  try {
    const agentId = c.get('agentId')
    const result = await addMemberToGroup(agentId, groupId, parsed.data.handle)
    return c.json(result, 201)
  } catch (e) {
    const mapped = handleError(e)
    if (mapped) return c.json(mapped.body, mapped.status)
    throw e
  }
})

// DELETE /v1/groups/:id/members/:handle — Kick a member (admin-only).
// The creator cannot be kicked — it's the only way out for them to
// leave is POST /v1/groups/:id/leave.
groups.delete('/:id/members/:handle', authMiddleware, idempotencyMiddleware, async (c) => {
  const groupId = c.req.param('id')
  const handle = c.req.param('handle')
  try {
    const agentId = c.get('agentId')
    await kickMember(agentId, groupId, handle)
    return c.json({ message: 'Member removed' })
  } catch (e) {
    const mapped = handleError(e)
    if (mapped) return c.json(mapped.body, mapped.status)
    throw e
  }
})

// POST /v1/groups/:id/members/:handle/promote — Promote to admin (admin-only).
groups.post('/:id/members/:handle/promote', authMiddleware, idempotencyMiddleware, async (c) => {
  const groupId = c.req.param('id')
  const handle = c.req.param('handle')
  try {
    const agentId = c.get('agentId')
    await promoteAdmin(agentId, groupId, handle)
    return c.json({ message: 'Member promoted to admin' })
  } catch (e) {
    const mapped = handleError(e)
    if (mapped) return c.json(mapped.body, mapped.status)
    throw e
  }
})

// POST /v1/groups/:id/members/:handle/demote — Demote admin to member
// (admin-only). Returns a specific error when trying to demote the last
// admin or the creator, so the client can show the right guidance.
groups.post('/:id/members/:handle/demote', authMiddleware, idempotencyMiddleware, async (c) => {
  const groupId = c.req.param('id')
  const handle = c.req.param('handle')
  try {
    const agentId = c.get('agentId')
    await demoteAdmin(agentId, groupId, handle)
    return c.json({ message: 'Admin demoted to member' })
  } catch (e) {
    const mapped = handleError(e)
    if (mapped) return c.json(mapped.body, mapped.status)
    throw e
  }
})

// DELETE /v1/groups/:id — Disband the entire group (creator-only; an
// admin may delete when the creator's account is suspended/deleted).
// Soft-delete: conversations.deleted_at is set, every active member is
// soft-left, pending invites are cancelled, and a final 'group_deleted'
// system message is written via the atomic RPC. Former members get a
// 410 Gone with DeletedGroupInfo on any subsequent read so the SDK can
// render "group was deleted by @alice"; non-members still see a masked
// 404 so they can't probe existence.
groups.delete('/:id', authMiddleware, idempotencyMiddleware, async (c) => {
  const groupId = c.req.param('id')
  try {
    const agentId = c.get('agentId')
    const result = await deleteGroup(agentId, groupId)
    return c.json({ message: 'Group deleted', deleted_at: result.deleted_at })
  } catch (e) {
    const mapped = handleError(e)
    if (mapped) return c.json(mapped.body, mapped.status)
    throw e
  }
})

// ─── Group avatar upload / remove ─────────────────────────────────────────
//
// PUT  /v1/groups/:id/avatar — admin uploads a new group avatar as raw
//                              image bytes (any image/* or application/
//                              octet-stream Content-Type accepted; format
//                              authoritatively determined by magic-byte
//                              sniff server-side).
// DELETE /v1/groups/:id/avatar — admin clears the group avatar.
//
// Mirrors PUT /v1/agents/:handle/avatar in body shape and rate-limit. The
// authorization difference is enforced inside group.service.setGroupAvatar
// via requireAdmin — non-admin members hit 403 there. Same per-agent rate
// bucket as the agent-avatar route so a flooded agent can't burn its
// budget across both surfaces.

type GroupAvatarErrorStatus = 400 | 403 | 404 | 410 | 413 | 429 | 500 | 503

function respondGroupAvatarError(c: Context, e: AvatarError | GroupError) {
  return c.json({ code: e.code, message: e.message }, e.status as GroupAvatarErrorStatus)
}

async function guardGroupAvatarWriteRate(c: Context, agentId: string) {
  const check = await checkAvatarWriteRateLimit(agentId)
  if (check.allowed) return null
  rateLimitHits.inc({ rule: 'avatar_write' })
  avatarsWritten.inc({ outcome: 'rate_limited' })
  if (check.retryAfterMs != null) {
    c.header('Retry-After', String(Math.ceil(check.retryAfterMs / 1000)))
  }
  return c.json(
    {
      code: 'RATE_LIMITED',
      message: 'Too many avatar writes per minute',
      retry_after_ms: check.retryAfterMs,
    },
    429,
  )
}

const groupAvatarBodyLimit = bodyLimit({
  maxSize: MAX_AVATAR_INPUT_BYTES,
  onError: (c) =>
    c.json(
      {
        code: 'PAYLOAD_TOO_LARGE',
        message: `Avatar exceeds the ${Math.floor(MAX_AVATAR_INPUT_BYTES / 1024 / 1024)} MB cap`,
      },
      413,
    ),
})

groups.put('/:id/avatar', authMiddleware, groupAvatarBodyLimit, async (c) => {
  const groupId = c.req.param('id')
  const agentId = c.get('agentId')

  const rateLimited = await guardGroupAvatarWriteRate(c, agentId)
  if (rateLimited) return rateLimited

  let bytes: Buffer
  try {
    const ab = await c.req.arrayBuffer()
    bytes = Buffer.from(ab)
  } catch (e) {
    return c.json(
      {
        code: 'VALIDATION_ERROR',
        message: `Could not read request body: ${(e as Error).message}`,
      },
      400,
    )
  }

  try {
    const result = await setGroupAvatar(agentId, groupId, bytes)
    return c.json(result)
  } catch (e) {
    if (e instanceof GroupError) return respondGroupAvatarError(c, e)
    if (e instanceof AvatarError) return respondGroupAvatarError(c, e)
    throw e
  }
})

groups.delete('/:id/avatar', authMiddleware, async (c) => {
  const groupId = c.req.param('id')
  const agentId = c.get('agentId')

  const rateLimited = await guardGroupAvatarWriteRate(c, agentId)
  if (rateLimited) return rateLimited

  try {
    const { existed } = await removeGroupAvatar(agentId, groupId)
    if (!existed) {
      return c.json({ code: 'NOT_FOUND', message: 'No avatar set' }, 404)
    }
    return c.json({ ok: true })
  } catch (e) {
    if (e instanceof GroupError) return respondGroupAvatarError(c, e)
    if (e instanceof AvatarError) return respondGroupAvatarError(c, e)
    throw e
  }
})

// POST /v1/groups/:id/leave — Leave the group yourself. If the caller is
// the last remaining admin, the earliest-joined member is auto-promoted;
// the response carries the new admin's handle so the client can show a
// sensible "ownership transferred" nudge.
groups.post('/:id/leave', authMiddleware, idempotencyMiddleware, async (c) => {
  const groupId = c.req.param('id')
  try {
    const agentId = c.get('agentId')
    const result = await leaveGroup(agentId, groupId)
    return c.json({
      message: 'Left group',
      promoted_handle: result.promoted_handle,
    })
  } catch (e) {
    const mapped = handleError(e)
    if (mapped) return c.json(mapped.body, mapped.status)
    throw e
  }
})

export { groups as groupRoutes }
