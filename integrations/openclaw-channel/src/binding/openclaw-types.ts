/**
 * Single import point for OpenClaw SDK types used across the binding layer.
 *
 * `openclaw/plugin-sdk/channel-core` exports the common types (`ChannelPlugin`,
 * `OpenClawConfig`, `buildChannelConfigSchema`, `defineChannelPluginEntry`).
 * `openclaw/plugin-sdk/channel-contract` re-exports the adapter interface
 * types that aren't in the core barrel. Anything that is neither in core
 * nor contract is derived here via indexed access on `ChannelPlugin`.
 *
 * Re-exporting from one place keeps every binding file's imports short and
 * makes it obvious where to look when an SDK minor version shuffles types
 * between barrels.
 */

export type {
  ChannelPlugin,
  OpenClawConfig,
  ChannelConfigUiHint,
} from 'openclaw/plugin-sdk/channel-core'

export type {
  ChannelAgentTool,
  ChannelDirectoryAdapter,
  ChannelDirectoryEntry,
  ChannelGatewayContext,
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
  ChannelMessageActionName,
  ChannelMessageToolDiscovery,
  ChannelOutboundAdapter,
  ChannelResolveKind,
  ChannelResolveResult,
  ChannelRuntimeSurface,
  ChannelStatusIssue,
} from 'openclaw/plugin-sdk/channel-contract'

import type { ChannelPlugin } from 'openclaw/plugin-sdk/channel-core'

// Adapter types not re-exported from the contract barrel — derive via
// indexed access on `ChannelPlugin`. `unknown` for `ResolvedAccount` keeps
// us portable; consumers narrow where it matters.
type AnyPlugin = ChannelPlugin<any> // eslint-disable-line @typescript-eslint/no-explicit-any

export type ChannelGatewayAdapter<T = unknown> = NonNullable<
  ChannelPlugin<T>['gateway']
>
export type ChannelMessagingAdapter = NonNullable<AnyPlugin['messaging']>
export type ChannelResolverAdapter = NonNullable<AnyPlugin['resolver']>
export type ChannelStatusAdapter<T = unknown, P = unknown> = NonNullable<
  ChannelPlugin<T, P>['status']
>
export type ChannelAgentToolFactoryFn = Extract<
  NonNullable<AnyPlugin['agentTools']>,
  (...args: any[]) => unknown // eslint-disable-line @typescript-eslint/no-explicit-any
>

/** One line the status adapter can surface to `openclaw channels status`. */
export type ChannelCapabilitiesDisplayLine = {
  text: string
  tone?: 'default' | 'muted' | 'success' | 'warn' | 'error'
}

/** One of the outbound-adapter delivery-result shapes we emit. */
export interface OutboundDeliveryResult {
  channel: string
  messageId: string
  conversationId?: string
  timestamp?: number
  meta?: Record<string, unknown>
}
