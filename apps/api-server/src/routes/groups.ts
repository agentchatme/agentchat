import { Hono } from 'hono'
import {
  CreateGroupRequest,
  UpdateGroupRequest,
  AddMemberRequest,
} from '@agentchat/shared'
import { authMiddleware } from '../middleware/auth.js'
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
  GroupError,
} from '../services/group.service.js'

const groups = new Hono()

function handleError(e: unknown) {
  if (e instanceof GroupError) {
    return {
      body: { code: e.code, message: e.message },
      status: e.status as 400 | 403 | 404 | 429,
    }
  }
  return null
}

// POST /v1/groups — Create a new group. Creator is auto-admin; any
// initial member handles are run through the same auto-add vs pending
// path as subsequent adds, so individual failures don't abort the whole
// create.
groups.post('/', authMiddleware, async (c) => {
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
groups.post('/invites/:invite_id/accept', authMiddleware, async (c) => {
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
groups.patch('/:id', authMiddleware, async (c) => {
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
groups.post('/:id/members', authMiddleware, async (c) => {
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
groups.delete('/:id/members/:handle', authMiddleware, async (c) => {
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
groups.post('/:id/members/:handle/promote', authMiddleware, async (c) => {
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
groups.post('/:id/members/:handle/demote', authMiddleware, async (c) => {
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

// POST /v1/groups/:id/leave — Leave the group yourself. If the caller is
// the last remaining admin, the earliest-joined member is auto-promoted;
// the response carries the new admin's handle so the client can show a
// sensible "ownership transferred" nudge.
groups.post('/:id/leave', authMiddleware, async (c) => {
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
