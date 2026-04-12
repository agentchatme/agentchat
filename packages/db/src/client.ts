import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let client: SupabaseClient | null = null

// Server-side Supabase client. MUST be stateless about auth sessions —
// otherwise a successful verifyOtp() in one request silently plants a user
// session on the cached singleton, and every subsequent storage call on the
// same machine uses that user's Bearer token instead of service_role. Storage
// RLS then denies the insert with "new row violates row-level security
// policy" and attachments break for the rest of the process lifetime.
//
// persistSession:false, autoRefreshToken:false, detectSessionInUrl:false tell
// the SDK to treat every auth call as fire-and-forget: no in-memory session,
// no token refresh loop, no URL-hash session detection (which is browser-only
// anyway). This keeps the client locked to service_role for DB and Storage.
export function getSupabaseClient(): SupabaseClient {
  if (!client) {
    const url = process.env['SUPABASE_URL']
    const key = process.env['SUPABASE_SERVICE_ROLE_KEY']
    if (!url || !key) {
      throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
    }
    client = createClient(url, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    })
  }
  return client
}
