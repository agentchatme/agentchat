/**
 * ChannelGatewayAdapter — start/stop the runtime per account.
 *
 * This is where the plugin actually becomes functional. OpenClaw calls
 * `startAccount` when a configured account is enabled; we spin up an
 * `AgentchatChannelRuntime`, wire the inbound bridge, and keep it alive
 * until `stopAccount` (or the ctx abort signal) fires.
 *
 * Inbound flow:
 *   WS frame → runtime.normalizeInbound → bridge.onInbound
 *     → OpenClaw dispatch → agent reply → runtime.sendMessage
 *
 * Outbound flow:
 *   OpenClaw.sendText → binding/outbound.ts → runtime.sendMessage
 *   (the outbound adapter lazy-starts the runtime if the agent calls
 *    sendText before startAccount has fired — e.g. from a cron one-shot)
 *
 * The runtime is registered in `runtime-registry.ts` so the outbound +
 * actions + tool paths can look it up by accountId.
 */

import type {
  ChannelGatewayAdapter,
  ChannelGatewayContext,
} from './openclaw-types.js'

import type { AgentchatResolvedAccount } from '../channel.js'
import { createLogger, type Logger } from '../log.js'
import {
  registerRuntime,
  unregisterRuntime,
  getRuntime,
} from './runtime-registry.js'
import {
  createInboundBridge,
  type ChannelRuntimeLike,
} from './inbound-bridge.js'

function adaptLog(log: ChannelGatewayContext['log']): Logger | undefined {
  if (!log) return undefined
  return {
    trace: (obj, msg) => log.debug?.(formatLogLine(obj, msg)),
    debug: (obj, msg) => log.debug?.(formatLogLine(obj, msg)),
    info: (obj, msg) => log.info(formatLogLine(obj, msg)),
    warn: (obj, msg) => log.warn(formatLogLine(obj, msg)),
    error: (obj, msg) => log.error(formatLogLine(obj, msg)),
    child: () => adaptLog(log)!,
  }
}

function formatLogLine(obj: object, msg?: string): string {
  const head = msg ?? ''
  const keys = Object.keys(obj)
  if (keys.length === 0) return head
  const tail = keys
    .map((k) => {
      const val = (obj as Record<string, unknown>)[k]
      return `${k}=${typeof val === 'string' ? val : JSON.stringify(val)}`
    })
    .join(' ')
  return head ? `${head} ${tail}` : tail
}

export const agentchatGatewayAdapter: ChannelGatewayAdapter<AgentchatResolvedAccount> = {
  async startAccount(ctx) {
    const account = ctx.account
    if (!account.enabled) {
      ctx.log?.info?.(`[agentchat:${ctx.accountId}] account disabled — skipping start`)
      return
    }
    if (!account.configured || !account.config) {
      ctx.log?.warn?.(
        `[agentchat:${ctx.accountId}] account not configured — skipping start`,
      )
      return
    }

    const logger =
      adaptLog(ctx.log) ??
      createLogger({
        level: account.config.observability.logLevel,
        redactKeys: account.config.observability.redactKeys,
      })

    // Runtime is constructed BEFORE we wire the bridge because the bridge
    // needs a handle to it (to route outbound replies back to AgentChat).
    // `registerRuntime` accepts the pre-built handlers; we set those in a
    // second pass via runtime options next. Actually — to keep wiring
    // simple, we accept an initial noop handlers arg, then swap the
    // `onInbound` via the closure.
    let runtimeRef: Awaited<ReturnType<typeof registerRuntime>> | null = null
    const bridge = (event: unknown) => {
      if (!runtimeRef) return
      const handler = createInboundBridge({
        accountId: ctx.accountId,
        config: account.config!,
        logger,
        runtime: runtimeRef,
        channelRuntime: ctx.channelRuntime as ChannelRuntimeLike | undefined,
        gatewayCfg: ctx.cfg,
        selfHandle: account.config!.agentHandle,
      })
      // Delegate to a fresh closure per event so we always see the latest
      // runtime + deps. Cheap — the bridge itself is pure logic.
      void handler(event as Parameters<ReturnType<typeof createInboundBridge>>[0])
    }

    runtimeRef = await registerRuntime({
      accountId: ctx.accountId,
      config: account.config,
      logger,
      handlers: {
        onInbound: bridge,
        onAuthenticated: (at) => {
          ctx.log?.info?.(`[agentchat:${ctx.accountId}] authenticated at ${new Date(at).toISOString()}`)
          ctx.setStatus({
            ...ctx.getStatus(),
            running: true,
            connected: true,
            linked: true,
            lastConnectedAt: at,
          })
        },
        onError: (err) => {
          ctx.log?.warn?.(
            `[agentchat:${ctx.accountId}] runtime error: ${err.message} (class=${err.class_})`,
          )
        },
        onStateChanged: (next) => {
          const running = next.kind !== 'CLOSED' && next.kind !== 'AUTH_FAIL'
          const connected = next.kind === 'READY' || next.kind === 'DEGRADED'
          ctx.setStatus({
            ...ctx.getStatus(),
            running,
            connected,
            healthState: next.kind,
          })
        },
        onBacklogWarning: (warning) => {
          ctx.log?.warn?.(
            `[agentchat:${ctx.accountId}] recipient backlog warning: @${warning.recipientHandle} has ${warning.undeliveredCount} undelivered`,
          )
        },
      },
    })

    // Honor graceful shutdown — when ctx.abortSignal aborts, tear down.
    ctx.abortSignal.addEventListener(
      'abort',
      () => {
        void unregisterRuntime(ctx.accountId, Date.now() + 5_000)
      },
      { once: true },
    )
  },

  async stopAccount(ctx) {
    await unregisterRuntime(ctx.accountId, Date.now() + 5_000)
    ctx.setStatus({
      ...ctx.getStatus(),
      running: false,
      connected: false,
    })
  },
}

export { getRuntime }
