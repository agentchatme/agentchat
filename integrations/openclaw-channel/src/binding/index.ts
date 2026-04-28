/**
 * Barrel for the OpenClaw ↔ AgentChat binding layer.
 *
 * Everything inside `src/binding/` is the bridge between our transport-
 * focused runtime and OpenClaw's plugin contract. Consumers of this
 * package rarely import from here directly; `channel.ts` wires the
 * adapters into the exported `agentchatPlugin`.
 */

export { agentchatGatewayAdapter } from './gateway.js'
export { agentchatOutboundAdapter } from './outbound.js'
export { agentchatMessagingAdapter } from './messaging.js'
export { agentchatActionsAdapter } from './actions.js'
export { agentchatAgentToolsFactory } from './agent-tools.js'
export { agentchatDirectoryAdapter } from './directory.js'
export { agentchatResolverAdapter } from './resolver.js'
export { agentchatStatusAdapter } from './status.js'

export {
  getClient,
  disposeClient,
  resetClientCacheForTest,
} from './sdk-client.js'

export {
  registerRuntime,
  unregisterRuntime,
  getRuntime,
  listActiveAccounts,
  resetRegistryForTest,
} from './runtime-registry.js'

export {
  createInboundBridge,
  type InboundBridgeDeps,
  type ChannelRuntimeLike,
} from './inbound-bridge.js'

export type { AgentchatProbeResult } from './status.js'
