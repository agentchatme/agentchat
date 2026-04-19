/**
 * Optional Prometheus metrics for the channel plugin.
 *
 * Design: the gateway owns the `/metrics` endpoint. Plugins do not expose
 * their own port. If the user passes a `prom-client` Registry via channel
 * runtime context, we register our counters/gauges/histograms into it.
 * Otherwise, we return a no-op recorder — zero overhead, zero config.
 *
 * Names are prefixed with `agentchat_channel_` for easy scraping.
 */

export interface MetricsRecorder {
  /** Incremented on every successfully delivered inbound message. */
  incInboundDelivered(labels: { kind: InboundKind }): void
  /** Incremented on every successfully sent outbound message. */
  incOutboundSent(labels: { kind: OutboundKind }): void
  /** Incremented on every send failure, labeled by error class. */
  incOutboundFailed(labels: { errorClass: string }): void
  /** Incremented on every reconnect attempt. */
  incReconnect(labels: { reason: string }): void
  /** Observe end-to-end send latency (ms). */
  observeSendLatency(ms: number): void
  /** Set the current connection state (cardinality bounded by state kinds). */
  setConnectionState(kind: string): void
  /** Set the current in-flight send queue depth. */
  setInFlightDepth(n: number): void
}

export type InboundKind = 'message' | 'group-message' | 'typing' | 'read' | 'presence' | 'rate-limit-warning'
export type OutboundKind = 'message' | 'typing' | 'read'

/**
 * Minimal contract for a prom-client-compatible registry. We accept anything
 * that exposes the `registerMetric` shape so consumers can pass their own
 * custom registry or a bare `Registry` from `prom-client`.
 */
export interface PromRegistryLike {
  registerMetric(metric: unknown): void
}

/**
 * Minimal contract for a prom-client factory. Keeping this abstract lets us
 * avoid a hard dep on `prom-client` while still being production-capable.
 * The caller passes `{ Counter, Gauge, Histogram }` from their own import.
 */
export interface PromFactory {
  Counter: new (cfg: MetricConfig) => {
    inc(labels?: Record<string, string>, value?: number): void
  }
  Gauge: new (cfg: MetricConfig) => {
    set(labelsOrValue: Record<string, string> | number, value?: number): void
  }
  Histogram: new (cfg: MetricConfig) => {
    observe(labelsOrValue: Record<string, string> | number, value?: number): void
  }
}

interface MetricConfig {
  name: string
  help: string
  labelNames?: readonly string[]
  buckets?: readonly number[]
  registers?: readonly unknown[]
}

export interface CreateMetricsOptions {
  registry: PromRegistryLike
  factory: PromFactory
}

export function createMetrics(options: CreateMetricsOptions): MetricsRecorder {
  const { registry, factory } = options

  const inboundDelivered = new factory.Counter({
    name: 'agentchat_channel_inbound_delivered_total',
    help: 'Inbound messages delivered to OpenClaw runtime.',
    labelNames: ['kind'],
    registers: [registry],
  })

  const outboundSent = new factory.Counter({
    name: 'agentchat_channel_outbound_sent_total',
    help: 'Outbound messages successfully sent to AgentChat.',
    labelNames: ['kind'],
    registers: [registry],
  })

  const outboundFailed = new factory.Counter({
    name: 'agentchat_channel_outbound_failed_total',
    help: 'Outbound send failures, labeled by error class.',
    labelNames: ['errorClass'],
    registers: [registry],
  })

  const reconnects = new factory.Counter({
    name: 'agentchat_channel_reconnect_total',
    help: 'WebSocket reconnect attempts.',
    labelNames: ['reason'],
    registers: [registry],
  })

  const sendLatency = new factory.Histogram({
    name: 'agentchat_channel_send_latency_ms',
    help: 'End-to-end latency of outbound send (ms).',
    buckets: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000],
    registers: [registry],
  })

  const connectionState = new factory.Gauge({
    name: 'agentchat_channel_connection_state',
    help: 'Current connection state (1 = active kind, 0 = otherwise).',
    labelNames: ['kind'],
    registers: [registry],
  })

  const inFlightDepth = new factory.Gauge({
    name: 'agentchat_channel_inflight_depth',
    help: 'Current in-flight outbound send queue depth.',
    registers: [registry],
  })

  return {
    incInboundDelivered: ({ kind }) => inboundDelivered.inc({ kind }),
    incOutboundSent: ({ kind }) => outboundSent.inc({ kind }),
    incOutboundFailed: ({ errorClass }) => outboundFailed.inc({ errorClass }),
    incReconnect: ({ reason }) => reconnects.inc({ reason }),
    observeSendLatency: (ms) => sendLatency.observe(ms),
    setConnectionState: (kind) => connectionState.set({ kind }, 1),
    setInFlightDepth: (n) => inFlightDepth.set(n),
  }
}

/** No-op recorder — used when the user does not provide a Prometheus registry. */
export function createNoopMetrics(): MetricsRecorder {
  return {
    incInboundDelivered: () => undefined,
    incOutboundSent: () => undefined,
    incOutboundFailed: () => undefined,
    incReconnect: () => undefined,
    observeSendLatency: () => undefined,
    setConnectionState: () => undefined,
    setInFlightDepth: () => undefined,
  }
}
