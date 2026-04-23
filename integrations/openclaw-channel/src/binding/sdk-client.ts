/**
 * Cached AgentChatClient-per-account wrapper.
 *
 * Every binding adapter that needs to call the REST API (actions, agentTools,
 * directory, resolver, status) goes through this module so we don't spin up a
 * new HTTP client on every call and so swap-on-rotate works uniformly.
 *
 * Keyed by `accountId`. On a key rotation the caller invalidates via
 * `disposeClient(accountId)` and the next `getClient` constructs a fresh one.
 */

import { AgentChatClient, type AgentChatClientOptions } from '@agentchatme/agentchat'

import type { AgentchatChannelConfig } from '../config-schema.js'
import { PACKAGE_VERSION } from '../version.js'

interface CacheEntry {
  readonly client: AgentChatClient
  readonly apiKey: string
  readonly apiBase: string
}

const cache = new Map<string, CacheEntry>()

export interface GetClientParams {
  readonly accountId: string
  readonly config: AgentchatChannelConfig
  readonly options?: Partial<AgentChatClientOptions>
}

/**
 * Return a shared `AgentChatClient` for `accountId`, reusing the cached
 * instance unless the apiKey or apiBase changed (implicit invalidation on
 * silent config drift — better than a stale key surviving a rotation).
 */
export function getClient({ accountId, config, options }: GetClientParams): AgentChatClient {
  const existing = cache.get(accountId)
  if (existing && existing.apiKey === config.apiKey && existing.apiBase === config.apiBase) {
    return existing.client
  }

  const client = new AgentChatClient({
    apiKey: config.apiKey,
    baseUrl: config.apiBase,
    ...options,
  })
  void PACKAGE_VERSION // reserved for a future X-AgentChat-Plugin-Version header

  cache.set(accountId, {
    client,
    apiKey: config.apiKey,
    apiBase: config.apiBase,
  })
  return client
}

/** Drop the cached client for `accountId` — e.g. after a key rotation. */
export function disposeClient(accountId: string): void {
  cache.delete(accountId)
}

/** Clear the entire cache. Test hook only. */
export function resetClientCacheForTest(): void {
  cache.clear()
}
