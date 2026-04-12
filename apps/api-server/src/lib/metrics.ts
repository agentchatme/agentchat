/**
 * Zero-dependency Prometheus-compatible metrics.
 *
 * Why not prom-client? The feature set we need (counters, histograms with
 * a handful of fixed buckets, a couple of gauges) fits in <200 LOC, and
 * avoiding the dep keeps the api-server install graph lean. If we ever
 * need labels-per-second aggregation or exemplars, swap this out — the
 * public surface (`counter.inc`, `histogram.observe`, `gauge.set`,
 * `serialize`) is a subset of prom-client's anyway, so the swap is cheap.
 *
 * All metrics live in a single module-level registry. `serialize()`
 * produces the standard Prometheus text exposition format which any
 * scraper (Prometheus, Grafana Agent, Datadog agent, OpenTelemetry
 * collector) can ingest directly.
 */

type LabelValues = Record<string, string>

interface MetricDef {
  name: string
  help: string
  type: 'counter' | 'gauge' | 'histogram'
}

interface CounterState extends MetricDef {
  type: 'counter'
  values: Map<string, number>
}

interface GaugeState extends MetricDef {
  type: 'gauge'
  provider: () => number
}

interface HistogramState extends MetricDef {
  type: 'histogram'
  buckets: number[]
  // labelKey → { bucketCounts[], sum, count }
  series: Map<string, { counts: number[]; sum: number; count: number }>
}

const registry = new Map<string, CounterState | GaugeState | HistogramState>()

// Stable label encoding so the same label set always hashes to the same key.
// Prometheus itself does this by sorting label names — we match so the
// output is diff-stable across runs and scrapers don't see spurious churn.
function encodeLabels(labels: LabelValues | undefined): string {
  if (!labels) return ''
  const keys = Object.keys(labels).sort()
  if (keys.length === 0) return ''
  return keys.map((k) => `${k}="${escapeLabelValue(labels[k] ?? '')}"`).join(',')
}

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

function assertName(name: string) {
  if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) {
    throw new Error(`Invalid metric name: ${name}`)
  }
}

export interface Counter {
  inc(labels?: LabelValues, by?: number): void
}

export interface Histogram {
  observe(value: number, labels?: LabelValues): void
}

export interface Gauge {
  /** Replace the provider — useful during tests. */
  set(provider: () => number): void
}

export function counter(name: string, help: string): Counter {
  assertName(name)
  const existing = registry.get(name)
  if (existing) {
    if (existing.type !== 'counter') {
      throw new Error(`Metric ${name} already registered with type ${existing.type}`)
    }
    return makeCounter(existing)
  }
  const state: CounterState = { name, help, type: 'counter', values: new Map() }
  registry.set(name, state)
  return makeCounter(state)
}

function makeCounter(state: CounterState): Counter {
  return {
    inc(labels, by = 1) {
      const key = encodeLabels(labels)
      state.values.set(key, (state.values.get(key) ?? 0) + by)
    },
  }
}

export function gauge(name: string, help: string, provider: () => number): Gauge {
  assertName(name)
  const existing = registry.get(name)
  if (existing) {
    if (existing.type !== 'gauge') {
      throw new Error(`Metric ${name} already registered with type ${existing.type}`)
    }
    ;(existing as GaugeState).provider = provider
    return { set: (p) => ((existing as GaugeState).provider = p) }
  }
  const state: GaugeState = { name, help, type: 'gauge', provider }
  registry.set(name, state)
  return { set: (p) => (state.provider = p) }
}

export function histogram(
  name: string,
  help: string,
  buckets: number[],
): Histogram {
  assertName(name)
  if (buckets.length === 0) throw new Error(`histogram ${name} needs at least one bucket`)
  const sorted = [...buckets].sort((a, b) => a - b)
  const existing = registry.get(name)
  if (existing) {
    if (existing.type !== 'histogram') {
      throw new Error(`Metric ${name} already registered with type ${existing.type}`)
    }
    return makeHistogram(existing as HistogramState)
  }
  const state: HistogramState = {
    name,
    help,
    type: 'histogram',
    buckets: sorted,
    series: new Map(),
  }
  registry.set(name, state)
  return makeHistogram(state)
}

function makeHistogram(state: HistogramState): Histogram {
  return {
    observe(value, labels) {
      const key = encodeLabels(labels)
      let s = state.series.get(key)
      if (!s) {
        s = { counts: new Array(state.buckets.length).fill(0), sum: 0, count: 0 }
        state.series.set(key, s)
      }
      s.sum += value
      s.count += 1
      for (let i = 0; i < state.buckets.length; i++) {
        if (value <= state.buckets[i]!) {
          s.counts[i]! += 1
        }
      }
    },
  }
}

/** Render the current registry in Prometheus text exposition format. */
export function serialize(): string {
  const parts: string[] = []
  for (const metric of registry.values()) {
    parts.push(`# HELP ${metric.name} ${metric.help}`)
    parts.push(`# TYPE ${metric.name} ${metric.type}`)

    if (metric.type === 'counter') {
      for (const [labelKey, value] of metric.values) {
        parts.push(`${metric.name}${labelKey ? `{${labelKey}}` : ''} ${value}`)
      }
    } else if (metric.type === 'gauge') {
      let v: number
      try {
        v = metric.provider()
      } catch {
        v = NaN
      }
      parts.push(`${metric.name} ${Number.isFinite(v) ? v : 0}`)
    } else if (metric.type === 'histogram') {
      for (const [labelKey, s] of metric.series) {
        const baseLabels = labelKey ? `${labelKey},` : ''
        for (let i = 0; i < metric.buckets.length; i++) {
          parts.push(
            `${metric.name}_bucket{${baseLabels}le="${metric.buckets[i]}"} ${s.counts[i]}`,
          )
        }
        parts.push(`${metric.name}_bucket{${baseLabels}le="+Inf"} ${s.count}`)
        parts.push(`${metric.name}_sum${labelKey ? `{${labelKey}}` : ''} ${s.sum}`)
        parts.push(`${metric.name}_count${labelKey ? `{${labelKey}}` : ''} ${s.count}`)
      }
    }
  }
  return parts.join('\n') + '\n'
}

// ─── Declared metrics ──────────────────────────────────────────────────────
//
// Centralized here so every call site imports from one place. Adding a new
// metric means adding an export here AND wiring the .inc / .observe / .set
// call at the relevant code path — nothing auto-instruments.

export const messagesSent = counter(
  'agentchat_messages_sent_total',
  'Total messages successfully sent, labeled by outcome.',
)

export const messagesSendRejected = counter(
  'agentchat_messages_send_rejected_total',
  'Messages rejected before storage, labeled by reason.',
)

export const webhookDeliveries = counter(
  'agentchat_webhook_deliveries_total',
  'Webhook delivery attempts completed, labeled by outcome.',
)

export const rateLimitHits = counter(
  'agentchat_rate_limit_hits_total',
  'Rate limit rejections, labeled by rule.',
)

export const wsConnectionsCurrent = gauge(
  'agentchat_ws_connections',
  'Current number of authenticated WebSocket connections.',
  () => 0, // will be replaced by registry at boot
)
