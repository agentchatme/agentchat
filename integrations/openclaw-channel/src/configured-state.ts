/**
 * Configured-state predicate for the AgentChat channel.
 *
 * OpenClaw calls this to decide whether the channel has "enough" config to
 * be considered active (counts toward enabled channels, shown in UI, etc.).
 *
 * Minimum bar: an `apiKey` of plausible length is present.
 */

export interface MaybeConfigured {
  readonly apiKey?: unknown
}

export function hasAgentChatConfiguredState(config: MaybeConfigured | undefined): boolean {
  if (!config || typeof config !== 'object') return false
  const key = config.apiKey
  return typeof key === 'string' && key.length >= 20
}
