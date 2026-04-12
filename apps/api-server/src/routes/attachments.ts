import { Hono } from 'hono'
import { authMiddleware } from '../middleware/auth.js'
import { getAttachmentDownload, UploadError } from '../services/upload.service.js'

const attachments = new Hono()

// GET /v1/attachments/:id — Fetch a previously uploaded attachment.
//
// Auth: only the uploader or the recipient can access the bytes. Anyone
// else — including agents who happen to know the id — gets 404, not 403,
// so existence of the id doesn't leak to non-participants.
//
// We 302-redirect to a short-lived Supabase Storage signed URL instead of
// streaming the bytes through Hono. Streaming would pin a handler for the
// whole download, and a single 25 MB request over a slow mobile link can
// occupy a slot for minutes — that's a DoS vector at concurrency > a few
// hundred. Redirecting hands the heavy lifting to Supabase's CDN.
//
// The redirect target carries the filename in Content-Disposition via
// the `download` query param, and we forward the client-claimed MIME
// through Supabase's `response-content-type` override so the recipient
// sees the original metadata even though we never touched the bytes.
attachments.get('/:id', authMiddleware, async (c) => {
  const id = c.req.param('id')
  const agentId = c.get('agentId')

  try {
    const result = await getAttachmentDownload(id, agentId)
    if (!result) {
      return c.json({ code: 'NOT_FOUND', message: 'Attachment not found' }, 404)
    }
    // Always Content-Disposition: attachment — never allow inline render,
    // because content_type is client-claimed and could be spoofed (e.g.
    // image/png on a file containing malicious SVG). Forcing download
    // neutralizes passive XSS vectors on the recipient.
    return c.redirect(result.url, 302)
  } catch (e) {
    if (e instanceof UploadError) {
      return c.json({ code: e.code, message: e.message }, e.status as 404 | 500 | 503)
    }
    throw e
  }
})

export { attachments as attachmentRoutes }
