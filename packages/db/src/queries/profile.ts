import { getSupabaseClient } from '../client.js'

/**
 * Dashboard cross-agent profile RPC. Resolves ownership of p_owner_handle,
 * then returns the public profile of p_target_handle only if the target is
 * either owned by the same owner OR shares a conversation with the owner's
 * agent. The internal agents.id is never returned — callers (service layer)
 * identify the target by handle and fetch presence through a private
 * handle → id lookup.
 *
 * Throws with message 'OWNER_AGENT_NOT_FOUND' or 'TARGET_NOT_VISIBLE' so the
 * service layer can map to 404 without string-matching in two places. Both
 * collapse to the same client-facing error code to avoid leaking whether a
 * handle exists outside the caller's reach.
 */
export async function getAgentProfileForOwnerRPC(params: {
  owner_id: string
  owner_handle: string
  target_handle: string
}) {
  const { data, error } = await getSupabaseClient().rpc(
    'get_agent_profile_for_owner',
    {
      p_owner_id: params.owner_id,
      p_owner_handle: params.owner_handle,
      p_target_handle: params.target_handle,
    },
  )
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as Array<{
    handle: string
    display_name: string | null
    description: string | null
    avatar_key: string | null
    created_at: string
    is_own: boolean
  }>
  return rows[0] ?? null
}
