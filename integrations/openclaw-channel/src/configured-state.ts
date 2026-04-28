/**
 * Configured-state predicate for the AgentChat channel.
 *
 * OpenClaw calls this to decide whether the channel has "enough" config to
 * be considered active (counts toward enabled channels, shown in UI, etc.).
 *
 * Bar: an `apiKey` of plausible length AND a non-empty `agentHandle`.
 * Without the handle the runtime will start but the agent has no identity
 * to add to prompts or to use as a self-filter on inbound — both
 * downstream surfaces silently degrade. Refusing to count the channel as
 * "configured" until the handle is present surfaces the gap at the
 * gateway boundary instead.
 */

export interface MaybeConfigured {
  readonly apiKey?: unknown
  readonly agentHandle?: unknown
}

export function hasAgentChatConfiguredState(config: MaybeConfigured | undefined): boolean {
  if (!config || typeof config !== 'object') return false
  const key = config.apiKey
  if (typeof key !== 'string' || key.length < 20) return false
  const handle = config.agentHandle
  if (typeof handle !== 'string' || handle.trim().length === 0) return false
  return true
}
