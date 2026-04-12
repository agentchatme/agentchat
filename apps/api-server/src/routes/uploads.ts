import { Hono } from 'hono'
import { CreateUploadRequest } from '@agentchat/shared'
import { authMiddleware } from '../middleware/auth.js'
import {
  createUpload,
  getAttachmentDownload,
  UploadError,
} from '../services/upload.service.js'

const uploads = new Hono()

// POST /v1/uploads — Reserve an attachment and return a presigned upload URL.
//
// The client is expected to PUT the file bytes directly to `upload_url`,
// then reference `attachment_id` in the content.data of a subsequent
// /v1/messages send. The api-server intentionally never sees the bytes.
uploads.post('/', authMiddleware, async (c) => {
  const agentId = c.get('agentId')
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }, 400)
  }
  const parsed = CreateUploadRequest.safeParse(body)
  if (!parsed.success) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: 'Invalid request', details: parsed.error.flatten() },
      400,
    )
  }

  try {
    const result = await createUpload(agentId, parsed.data)
    return c.json(result, 201)
  } catch (e) {
    if (e instanceof UploadError) {
      return c.json({ code: e.code, message: e.message }, e.status as 400 | 403 | 404 | 500 | 503)
    }
    throw e
  }
})

export { uploads as uploadRoutes }
