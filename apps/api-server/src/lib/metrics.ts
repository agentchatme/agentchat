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

// Mute writes (POST /v1/mutes, DELETE /v1/mutes/:kind/:id). Labeled by
// outcome so dashboards can split the happy path from client errors and
// rate-limit trips in a single counter:
//
//   outcome="created"        — POST resolved to a new-or-refreshed row
//   outcome="removed"        — DELETE deleted an active row
//   outcome="rejected"       — MuteError before the DB write
//                              (self-mute, not-participant, bad kind,
//                              agent/conversation not found, past muted_until)
//   outcome="rate_limited"   — guardMuteWriteRate tripped; handler never ran
//
// Sustained non-zero rejected + rate_limited rates are the operator
// signal that a client is looping or misconfigured. `created` and
// `removed` together track organic feature usage.
export const mutesWritten = counter(
  'agentchat_mutes_written_total',
  'Mute write outcomes (created|removed|rejected|rate_limited).',
)

// Avatar writes (PUT /v1/agents/:handle/avatar, DELETE same). Labeled by
// outcome so dashboards can split organic uploads from validation failures
// and rate-limit trips in a single counter:
//
//   outcome="uploaded"       — PUT processed, stored, row updated
//   outcome="removed"        — DELETE cleared the row and deleted storage bytes
//   outcome="rejected"       — AvatarError before storage write
//                              (bad magic, wrong content type, too large,
//                              image too small, decompression bomb)
//   outcome="rate_limited"   — guardAvatarWriteRate tripped; handler never ran
//   outcome="storage_error"  — upload to Supabase Storage failed after the
//                              processing pipeline already succeeded (503)
//
// Sustained rejected is the signal that clients are sending bad data and
// likely need an SDK fix; sustained storage_error means the bucket is
// unhealthy; rate_limited dominating means a broken client loop.
export const avatarsWritten = counter(
  'agentchat_avatars_written_total',
  'Avatar write outcomes (uploaded|removed|rejected|rate_limited|storage_error).',
)

export const wsConnectionsCurrent = gauge(
  'agentchat_ws_connections',
  'Current number of authenticated WebSocket connections.',
  () => 0, // will be replaced by registry at boot
)

export const wsBackpressureCloses = counter(
  'agentchat_ws_backpressure_closes_total',
  'WebSocket sockets force-closed for exceeding the send-buffer ceiling.',
)

export const webhooksDead = gauge(
  'agentchat_webhook_deliveries_dead',
  'Webhook deliveries currently in the dead-letter queue (status=dead).',
  () => 0, // worker overrides via setProvider on boot
)

// Number of webhook endpoints whose circuit breaker is currently OPEN
// (all delivery attempts skipped pending cooldown). Sustained non-zero
// here means a customer's receiver is sick — pair with the deliveries
// counter labeled outcome=failed to tell "many endpoints flapping" from
// "one endpoint hard down".
export const webhookCircuitsOpen = gauge(
  'agentchat_webhook_circuits_open',
  'Webhook endpoints with an OPEN circuit breaker (deliveries paused).',
  () => 0, // dlq-probe overrides via setProvider on boot
)

// Drift between the cached agents.undelivered_count counter and the
// authoritative SUM via COUNT(message_deliveries WHERE status='stored').
// Should always be 0. Sustained non-zero means a code path mutated a
// delivery's status without going through the trigger that maintains
// the counter — bug, partition skew, or a manual UPDATE somewhere.
// Sign convention: counter_sum - actual_count, so positive = counter
// over-counted, negative = counter under-counted.
export const undeliveredCountDrift = gauge(
  'agentchat_undelivered_count_drift',
  'Drift between agents.undelivered_count sum and COUNT of stored deliveries.',
  () => 0, // dlq-probe overrides via setProvider on boot
)

// ─── Group deletion fan-out queue (migration 030) ─────────────────────────
//
// Per-recipient durable queue drained by group-deletion-fanout-worker.
// The dead gauge + outcome counter pair tells operators the same story
// the webhook metrics do: "are deliveries succeeding / failing / giving
// up?". Tick duration histogram surfaces backpressure (slow DB, slow
// webhook enqueue) before it becomes a queue-depth problem.

export const groupDeletionFanout = counter(
  'agentchat_group_deletion_fanout_total',
  'Group-deletion fan-out outcomes per recipient row, labeled by outcome.',
)

export const groupDeletionFanoutDead = gauge(
  'agentchat_group_deletion_fanout_dead',
  'Group-deletion fan-out rows currently in the dead-letter queue (status=dead).',
  () => 0, // dlq-probe overrides via setProvider on boot
)

// Buckets sized to the realistic tick range: a healthy tick (cache-warm,
// no failures) lands in 10–100ms; a slow tick (DB blip, large batch with
// many fireWebhooks fan-outs) lands in the seconds bucket; anything past
// 30s is a problem worth alerting on.
export const groupDeletionFanoutTickSeconds = histogram(
  'agentchat_group_deletion_fanout_tick_seconds',
  'Wall-clock duration of one fan-out worker tick (claim + process + finalize).',
  [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30],
)

// ─── Message outbox worker (migration 031) ────────────────────────────────
//
// The outbox worker drains message_outbox into webhook_deliveries in the
// transaction-committed follow-up to send_message_atomic. Its health is
// "does the queue stay at steady-state near zero?" — this pair of metrics
// surfaces both throughput (counter) and slow ticks (histogram). A steady
// non-zero orphaned/failed rate is a real signal; delivered dominates in
// healthy operation.

export const outboxProcessed = counter(
  'agentchat_outbox_processed_total',
  'Message outbox rows processed, labeled by outcome (delivered|no_webhooks|orphaned|failed).',
)

// Same bucket scheme as the group-deletion fan-out worker — comparable
// workloads (DB-only tick, no external calls), so the healthy band is
// low-tens of ms and the alarm band is seconds.
export const outboxTickSeconds = histogram(
  'agentchat_outbox_tick_seconds',
  'Wall-clock duration of one outbox-worker tick (claim + batch-resolve + process).',
  [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30],
)

// ─── Redis pub/sub (cross-machine WebSocket fan-out) ──────────────────────
//
// Pub/sub is the bridge that lets a message arriving on api machine #1
// reach a WebSocket connected to api machine #3. If pub/sub silently
// degrades — publisher disconnect, subscriber disconnect, network blip —
// fan-out goes local-only on the affected machine and ~5/6 of recipients
// stop receiving live pushes. The blast radius is invisible without
// metrics: messages still hit Postgres, recipients still drain on next
// /sync, but real-time delivery breaks for everyone not lucky enough to
// be on the same machine as the sender.
//
// These metrics are the canary. Publishes_total + the connected gauges
// drive the dashboard ("are we reaching every machine right now?"); the
// fallbacks counter is the leading indicator of degradation; the latency
// histogram catches "Redis is reachable but slow"; the reconnects counter
// surfaces flap behavior that the connected gauges can miss between
// scrape intervals.

export const pubsubPublishes = counter(
  'agentchat_pubsub_publishes_total',
  'Pub/sub publish attempts, labeled by channel + outcome (success|failure).',
)

export const pubsubMessagesReceived = counter(
  'agentchat_pubsub_messages_received_total',
  'Pub/sub messages received by the subscriber, labeled by channel.',
)

// Incremented when the publish path threw (Redis unreachable, slow, or
// otherwise) and the code fell back to local-only delivery via
// deliverLocally* helpers. A non-zero rate here means cross-machine
// fan-out is degraded right now — recipients on other machines are not
// receiving the live push for the messages counted here. They'll still
// catch up on /sync after reconnect, but the real-time guarantee is broken.
export const pubsubLocalFallbacks = counter(
  'agentchat_pubsub_local_fallbacks_total',
  'Times a publish failed and the code fell back to local-only delivery.',
)

// Increments on every ioredis 'reconnecting' event. Healthy steady state
// is zero growth. Any non-zero rate is worth investigating — a flapping
// Redis connection causes the subscriber to miss messages published
// during the reconnect gap (ioredis does NOT replay missed pub/sub frames
// on reconnect — that's a Redis protocol limitation, not an ioredis
// choice). Sustained reconnects = sustained fan-out gaps.
export const pubsubReconnects = counter(
  'agentchat_pubsub_reconnects_total',
  'ioredis reconnect events, labeled by role (publisher|subscriber).',
)

// 1 when the publisher's TCP connection to Redis is up and AUTH'd; 0
// otherwise. Single-process gauge — when scraping a 6-machine cluster,
// you sum or average across instances depending on what you're asking
// ("are ALL machines connected?" vs "what fraction is connected?").
export const pubsubPublisherConnected = gauge(
  'agentchat_pubsub_publisher_connected',
  'Publisher Redis connection state on this process (1=ready, 0=down).',
  () => 0, // pubsub.ts overrides via .set on init
)

// Same shape as the publisher gauge but for the subscriber client. The
// SUBSCRIBER going down is the more catastrophic of the two — this
// process stops receiving any cross-machine fan-out at all, silently.
// Pair this gauge with the sustained-disconnect Sentry alert in pubsub.ts
// for the full coverage: the gauge tells you the current state, the alert
// tells you when current state has been "down" long enough to matter.
export const pubsubSubscriberConnected = gauge(
  'agentchat_pubsub_subscriber_connected',
  'Subscriber Redis connection state on this process (1=ready, 0=down).',
  () => 0, // pubsub.ts overrides via .set on init
)

// Redis publish round-trip. Healthy is sub-millisecond on Upstash from
// the same region; anything past 100ms means the link is degraded
// (cross-region routing, Upstash throttling, or our own connection
// pool exhaustion). Buckets cover the full realistic range — the 5s
// bucket exists so a hung publish that eventually times out lands in
// a real bucket instead of +Inf, which makes the histogram unhelpfully
// flat for outage post-mortems.
export const pubsubPublishSeconds = histogram(
  'agentchat_pubsub_publish_seconds',
  'Wall-clock duration of one Redis PUBLISH, labeled by channel.',
  [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
)
