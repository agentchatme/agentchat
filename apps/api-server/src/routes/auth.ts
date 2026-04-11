import { Hono } from 'hono'
import { z } from 'zod'
import { getSupabaseClient } from '@agentchat/db'
import { ipRateLimit } from '../middleware/rate-limit.js'

const auth = new Hono()

const AuthRequest = z.object({
  email: z.string().email(),
  password: z.string().min(8),
})

// POST /v1/auth/signup — Create owner account (5 per hour per IP)
auth.post('/signup', ipRateLimit(5, 3600), async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }, 400)
  }

  const parsed = AuthRequest.safeParse(body)
  if (!parsed.success) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid request', details: parsed.error.flatten() }, 400)
  }

  const { email, password } = parsed.data
  const supabase = getSupabaseClient()

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })

  if (error) {
    if (error.message.includes('already been registered')) {
      return c.json({ code: 'HANDLE_TAKEN', message: 'Email already registered' }, 409)
    }
    return c.json({ code: 'INTERNAL_ERROR', message: error.message }, 500)
  }

  // Sign in immediately to get tokens
  const { data: session, error: signInError } = await supabase.auth.signInWithPassword({
    email,
    password,
  })

  if (signInError) {
    return c.json({ code: 'INTERNAL_ERROR', message: signInError.message }, 500)
  }

  return c.json({
    owner_id: data.user.id,
    access_token: session.session?.access_token,
    refresh_token: session.session?.refresh_token,
  }, 201)
})

// POST /v1/auth/login — Login as owner (10 per minute per IP)
auth.post('/login', ipRateLimit(10, 60), async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid JSON body' }, 400)
  }

  const parsed = AuthRequest.safeParse(body)
  if (!parsed.success) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid request', details: parsed.error.flatten() }, 400)
  }

  const { email, password } = parsed.data
  const supabase = getSupabaseClient()

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  })

  if (error) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Invalid email or password' }, 401)
  }

  return c.json({
    owner_id: data.user.id,
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  })
})

export { auth as authRoutes }
