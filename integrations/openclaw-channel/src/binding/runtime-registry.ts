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

/**
 * Per-account mutex. Every `registerRuntime` / `unregisterRuntime` call for
 * the same account runs through this queue, so concurrent starts or a
 * start-during-stop never race. The entries are raw promise tails — we
 * drop them after the operation resolves to keep the map bounded.
 */
const accountLocks = new Map<string, Promise<unknown>>()

function withAccountLock<T>(accountId: string, op: () => Promise<T>): Promise<T> {
  const prev = accountLocks.get(accountId) ?? Promise.resolve()
  // Swallow the prior result/error so one caller's failure doesn't poison
  // the next caller's execution.
  const next = prev.catch(() => undefined).then(op)
  accountLocks.set(accountId, next)
  // Clear the map entry once this op settles AND no later op chained onto
  // it. The `accountLocks.get === next` check guards against clearing a
  // newer tail that was appended while we were running. We attach the
  // `finally` via `.then(undefined, ...)` chaining that owns its own
  // error handler, because `next.finally(...)` alone would return an
  // unhandled rejection when `next` rejects and nothing else awaits it.
  next.then(
    () => {
      if (accountLocks.get(accountId) === next) accountLocks.delete(accountId)
    },
    () => {
      if (accountLocks.get(accountId) === next) accountLocks.delete(accountId)
    },
  )
  return next
}

export interface RegisterRuntimeParams {
  readonly accountId: string
  readonly config: AgentchatChannelConfig
  readonly handlers: ChannelRuntimeHandlers
  readonly logger: Logger
}

/**
 * Create and start a runtime for `accountId`. If one is already registered,
 * stop it first (config change path). Returns the live instance.
 *
 * Serialized per-account via `withAccountLock` so two concurrent callers
 * cannot double-start or interleave a start with a stop.
 */
export function registerRuntime(
  params: RegisterRuntimeParams,
): Promise<AgentchatChannelRuntime> {
  return withAccountLock(params.accountId, async () => {
    const existing = registry.get(params.accountId)
    if (existing) {
      try {
        await existing.runtime.stop(Date.now() + 2_000)
      } catch (err) {
        params.logger.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            accountId: params.accountId,
          },
          'previous runtime stop threw during re-register — replacing anyway',
        )
      }
      registry.delete(params.accountId)
    }

    const runtime = new AgentchatChannelRuntime({
      config: params.config,
      handlers: params.handlers,
      logger: params.logger,
    })
    // Register BEFORE start so a handler firing on the sync path of
    // `start()` can find the runtime via `getRuntime`.
    registry.set(params.accountId, {
      runtime,
      config: params.config,
      logger: params.logger,
      abortController: new AbortController(),
    })
    try {
      runtime.start()
    } catch (err) {
      // Synchronous start failure — back out of the registry so the next
      // caller can try fresh, and surface the error.
      registry.delete(params.accountId)
      throw err
    }
    return runtime
  })
}

/**
 * Stop and remove the runtime for `accountId`. No-op if absent.
 * `deadlineMs` bounds the graceful-drain wait.
 *
 * Serialized per-account so a concurrent `registerRuntime` cannot race
 * this stop and leave a zombie.
 */
export function unregisterRuntime(
  accountId: string,
  deadlineMs = Date.now() + 5_000,
): Promise<void> {
  return withAccountLock(accountId, async () => {
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
  })
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
