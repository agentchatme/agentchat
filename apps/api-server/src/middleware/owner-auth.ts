import { createMiddleware } from 'hono/factory'
import { getSupabaseClient } from '@agentchat/db'

export const ownerAuthMiddleware = createMiddleware<{
  Variables: {
    ownerId: string
  }
}>(async (c, next) => {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Missing or invalid Authorization header' }, 401)
  }

  const token = authHeader.slice(7)
  const supabase = getSupabaseClient()

  const { data, error } = await supabase.auth.getUser(token)

  if (error || !data.user) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Invalid or expired token' }, 401)
  }

  c.set('ownerId', data.user.id)
  return next()
})
