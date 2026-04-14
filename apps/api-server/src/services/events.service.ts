import { insertEvent } from '@agentchat/db'
import { generateId } from '../lib/id.js'

// ─── Events service ────────────────────────────────────────────────────────
// Thin wrapper around insertEvent that generates the event ID and handles
// failures silently. Events are audit trail — they should NEVER block the
// primary operation. If the events table is down, the agent still sends
// its message, rotates its key, gets blocked, etc.; we just lose the
// audit row and log a warning.
//
// The one exception is rotate_api_key_atomic — that one MUST succeed
// transactionally because it also deletes the claim, and we don't want
// a half-rotated state. That flow calls rotateApiKeyAtomic directly and
// intentionally does NOT use this helper.

export type ActorType = 'owner' | 'agent' | 'system'

export async function emitEvent(params: {
  actorType: ActorType
  actorId: string
  action: string
  targetId: string
  metadata?: Record<string, unknown>
}): Promise<void> {
  try {
    await insertEvent({
      id: generateId('evt'),
      actor_type: params.actorType,
      actor_id: params.actorId,
      action: params.action,
      target_id: params.targetId,
      metadata: params.metadata ?? {},
    })
  } catch (err) {
    console.error('[events] emit failed:', params.action, params.targetId, err)
  }
}
