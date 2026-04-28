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

import { waitUntilAbort } from 'openclaw/plugin-sdk/channel-lifecycle'

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

    // Runtime and bridge wiring form a small chicken-and-egg: the bridge
    // handler closes over the runtime (for reply dispatch), and the runtime
    // closes over the bridge (as its `onInbound` handler). We solve it with
    // one mutable ref for the runtime, closed over by a single bridge
    // handler that's constructed once — reused per event, not allocated.
    let runtimeRef: Awaited<ReturnType<typeof registerRuntime>> | null = null
    let inboundHandler: ReturnType<typeof createInboundBridge> | null = null
    const bridge = (event: unknown) => {
      if (!runtimeRef || !inboundHandler) return
      void inboundHandler(event as Parameters<ReturnType<typeof createInboundBridge>>[0])
    }

    runtimeRef = await registerRuntime({
      accountId: ctx.accountId,
      config: account.config,
      logger,
      handlers: {
        onInbound: bridge,
        // `runtime` used below is captured AFTER registerRuntime resolves,
        // but the handler is never invoked before that — the WS has to
        // authenticate first. Safe to assign synchronously just after.

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

    // Construct the per-event inbound handler ONCE now that `runtimeRef`
    // is populated. Reusing it avoids allocating a fresh closure per
    // inbound frame — at multi-hundred-msg/sec this matters.
    inboundHandler = createInboundBridge({
      accountId: ctx.accountId,
      config: account.config,
      logger,
      runtime: runtimeRef,
      channelRuntime: ctx.channelRuntime as ChannelRuntimeLike | undefined,
      gatewayCfg: ctx.cfg,
      selfHandle: account.config.agentHandle,
    })

    // Keep the channel task pending until OpenClaw aborts. Without this,
    // startAccount resolves immediately after wiring the runtime — and
    // OpenClaw's task-runner (server-channels.ts:475 "channel exited")
    // treats the resolved promise as a graceful exit and triggers
    // auto-restart with backoff. Each restart calls registerRuntime,
    // which stops the existing runtime first (DRAIN_REQUESTED), draining
    // the WebSocket and killing in-flight inbound dispatches before the
    // LLM can complete. The result is the flap loop we observed:
    // READY → DRAINING → CONNECTING → AUTHENTICATING → READY → DRAINING
    // every 1-3 minutes, with auto-restart attempt counter ticking up
    // until OpenClaw gives up after 10 attempts.
    //
    // waitUntilAbort is the canonical OpenClaw plugin-sdk lifecycle
    // helper — see openclaw/src/plugin-sdk/channel-lifecycle.core.ts:30
    // and the runPassiveAccountLifecycle pattern used by IRC, Google
    // Chat, etc. The onAbort callback runs (and is awaited) before the
    // promise resolves, so our cleanup happens fully before OpenClaw
    // sees the task complete — no stop/start race.
    await waitUntilAbort(ctx.abortSignal, async () => {
      try {
        await unregisterRuntime(ctx.accountId, Date.now() + 5_000)
      } catch (err) {
        ctx.log?.error?.(
          `[agentchat:${ctx.accountId}] unregisterRuntime failed on abort: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    })
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
