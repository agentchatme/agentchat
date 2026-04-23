/**
 * Per-account AgentchatChannelRuntime registry.
 *
 * OpenClaw's gateway starts one runtime per `(channelId, accountId)` pair at
 * channel enable. On shutdown it stops them. We hold the Runtime instance here
 * so binding adapters (outbound, actions) can dispatch through the same
 * WebSocket the gateway started, rather than re-opening a new transport per
 * call.
 *
 * Keying is `accountId`-only; `channelId` is always `"agentchat"` for this
 * plugin, so it does not contribute to the key.
 */

import type { Logger } from '../log.js'
import type { AgentchatChannelConfig } from '../config-schema.js'
import { AgentchatChannelRuntime, type ChannelRuntimeHandlers } from '../runtime.js'

interface RegistryEntry {
  readonly runtime: AgentchatChannelRuntime
  readonly config: AgentchatChannelConfig
  readonly logger: Logger
  readonly abortController: AbortController
}

const registry = new Map<string, RegistryEntry>()

export interface RegisterRuntimeParams {
  readonly accountId: string
  readonly config: AgentchatChannelConfig
  readonly handlers: ChannelRuntimeHandlers
  readonly logger: Logger
}

/**
 * Create and start a runtime for `accountId`. If one is already registered,
 * stop it first (config change path). Returns the live instance.
 */
export async function registerRuntime(
  params: RegisterRuntimeParams,
): Promise<AgentchatChannelRuntime> {
  const existing = registry.get(params.accountId)
  if (existing) {
    await existing.runtime.stop(Date.now() + 2_000)
    registry.delete(params.accountId)
  }

  const runtime = new AgentchatChannelRuntime({
    config: params.config,
    handlers: params.handlers,
    logger: params.logger,
  })
  runtime.start()

  registry.set(params.accountId, {
    runtime,
    config: params.config,
    logger: params.logger,
    abortController: new AbortController(),
  })
  return runtime
}

/**
 * Stop and remove the runtime for `accountId`. No-op if absent.
 * `deadlineMs` bounds the graceful-drain wait.
 */
export async function unregisterRuntime(
  accountId: string,
  deadlineMs = Date.now() + 5_000,
): Promise<void> {
  const entry = registry.get(accountId)
  if (!entry) return
  registry.delete(accountId)
  entry.abortController.abort()
  try {
    await entry.runtime.stop(deadlineMs)
  } catch (err) {
    entry.logger.error(
      { err: err instanceof Error ? err.message : String(err), accountId },
      'runtime.stop threw during unregister',
    )
  }
}

/**
 * Return the live runtime for `accountId`, or `undefined` if none. Binding
 * adapters that need to send through the WS use this; a missing runtime means
 * the channel is not started for this account — the caller should fall back
 * to HTTP-only paths.
 */
export function getRuntime(accountId: string): AgentchatChannelRuntime | undefined {
  return registry.get(accountId)?.runtime
}

/** List every active account id. Test + introspection hook. */
export function listActiveAccounts(): string[] {
  return [...registry.keys()]
}

/** Nuke every runtime. Test hook only. */
export async function resetRegistryForTest(): Promise<void> {
  const entries = [...registry.entries()]
  registry.clear()
  await Promise.all(
    entries.map(async ([, entry]) => {
      try {
        await entry.runtime.stop(Date.now() + 500)
      } catch {
        /* test teardown — swallow */
      }
    }),
  )
}
