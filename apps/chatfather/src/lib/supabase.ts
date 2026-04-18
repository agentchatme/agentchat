import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { env } from '../env.js'

// ─── Lazy Supabase client ──────────────────────────────────────────────────
//
// Shared across chatfather modules (age-gate, escalation queue). Service-
// role only — chatfather has no user session and needs to read/write
// platform tables directly. Persistence and auto-refresh are disabled
// because the Fly machine has no filesystem session and doesn't need a
// background timer calling Supabase once an hour.

let client: SupabaseClient | null = null

export function getSupabase(): SupabaseClient {
  if (!client) {
    client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    })
  }
  return client
}
