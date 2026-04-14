import { getSupabaseClient } from '../client.js'

// ─── Owners ────────────────────────────────────────────────────────────────
// An Owner is a human using the dashboard. id mirrors auth.users.id so the
// Supabase Auth JWT maps directly to an owners row.
//
// Email-namespace isolation is enforced at three layers:
//   1. Application guards in POST /v1/register and /dashboard/auth/otp/request
//   2. Partial unique index owners_email_active
//   3. BEFORE INSERT trigger enforce_email_namespace_isolation
// These queries assume the DB layer will reject any cross-contamination;
// callers only need to check the app-layer guards to surface a clean error.

export async function findActiveOwnerByEmail(email: string) {
  const { data, error } = await getSupabaseClient()
    .from('owners')
    .select('*')
    .eq('email', email.toLowerCase().trim())
    .is('deleted_at', null)
    .single()
  if (error) return null
  return data
}

export async function findOwnerById(id: string) {
  const { data, error } = await getSupabaseClient()
    .from('owners')
    .select('*')
    .eq('id', id)
    .is('deleted_at', null)
    .single()
  if (error) return null
  return data
}

export async function insertOwner(owner: {
  id: string
  email: string
  display_name?: string | null
}) {
  const { data, error } = await getSupabaseClient()
    .from('owners')
    .insert({
      id: owner.id,
      email: owner.email.toLowerCase().trim(),
      display_name: owner.display_name ?? null,
    })
    .select()
    .single()

  if (error) throw error
  return data
}

export async function updateOwner(
  id: string,
  updates: { display_name?: string | null },
) {
  const { data, error } = await getSupabaseClient()
    .from('owners')
    .update(updates)
    .eq('id', id)
    .is('deleted_at', null)
    .select()
    .single()

  if (error) throw error
  return data
}

export async function softDeleteOwner(id: string) {
  const { error } = await getSupabaseClient()
    .from('owners')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)

  if (error) throw error
}
