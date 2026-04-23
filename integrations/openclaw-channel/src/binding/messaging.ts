/**
 * ChannelMessagingAdapter — target parsing + conversation routing.
 *
 * Two jobs:
 *   1. Normalize agent-supplied target strings ("@alice", "alice",
 *      "conv_abc", "grp_xyz") into a canonical form the rest of the pipeline
 *      can rely on.
 *   2. Classify conversation ids (`conv_*`/`dir_*` = direct, `grp_*` = group)
 *      so outbound + actions can route without re-parsing prefixes.
 *
 * We deliberately do NOT do directory lookups here — the resolver adapter
 * owns that. Messaging stays syntactic; resolver stays semantic.
 */

import type { ChannelMessagingAdapter } from './openclaw-types.js'

import { classifyConversationId, type ConversationKind } from '../inbound.js'

/**
 * Canonicalize a target string.
 *
 *   "@alice"     → "alice"
 *   "Alice"      → "alice"
 *   " alice "    → "alice"
 *   "conv_abc"   → "conv_abc" (passthrough — looks like an id)
 *   "grp_xyz"    → "grp_xyz"  (passthrough)
 *   ""           → undefined  (callers treat this as "no target")
 *
 * Returns `undefined` for anything that's empty after trim so downstream
 * doesn't have to `if (!trimmed)` everywhere.
 */
export function normalizeAgentchatTarget(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  // Conversation ids already look canonical — leave them alone.
  if (classifyConversationId(trimmed) !== null) return trimmed
  // Strip the leading "@" agents often copy from the skill / UI.
  const stripped = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed
  return stripped.toLowerCase()
}

/**
 * Infer chat type from a raw target. Returns `undefined` when ambiguous
 * (bare handle). Core only uses this hint to steer directory lookup so
 * ambiguity is safe — it will fall through to the full resolver.
 */
export function inferAgentchatTargetChatType(raw: string): 'direct' | 'group' | undefined {
  const trimmed = raw.trim()
  const kind: ConversationKind | null = classifyConversationId(trimmed)
  if (kind === 'direct') return 'direct'
  if (kind === 'group') return 'group'
  return undefined
}

export const agentchatMessagingAdapter: ChannelMessagingAdapter = {
  normalizeTarget: normalizeAgentchatTarget,
  inferTargetChatType: ({ to }) => inferAgentchatTargetChatType(to),
}
