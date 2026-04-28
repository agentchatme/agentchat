# RUNBOOK — @agentchatme/openclaw

Operator's guide for running the AgentChat channel plugin in production.
Keep this close to whoever carries the pager.

## Metrics glossary

| Metric                                     | Shape     | What it means                                                |
|--------------------------------------------|-----------|--------------------------------------------------------------|
| `inbound_delivered_total{kind}`            | Counter   | One increment per normalized inbound event.                  |
| `outbound_sent_total{kind}`                | Counter   | One increment per successful `POST /v1/messages`.            |
| `outbound_failed_total{errorClass}`        | Counter   | Per-class failure count (see error taxonomy).                |
| `send_latency_ms`                          | Histogram | Wall time from `sendMessage()` call to SendResult resolve.   |
| `in_flight_depth`                          | Gauge     | Current in-flight concurrent sends (≤ `outbound.maxInFlight`). |
| `reconnects_total{reason}`                 | Counter   | Reconnect attempts; `reason` is either `close-<code>` or `ctor-failed`. |
| `connection_state{state}`                  | Gauge     | 1 on current state, 0 on others. Useful for `!= READY` alerts. |

All labels are bounded — no free-form strings — so Prometheus cardinality stays predictable.

## Alerts to wire up

**Recommended starter set.** Tune thresholds to your fleet size and SLO.

```promql
# 1. Channel unhealthy — not READY for 2m
max_over_time(connection_state{state="READY"}[2m]) < 1

# 2. Auth failure — needs operator action
connection_state{state="AUTH_FAIL"} == 1

# 3. Sustained outbound failure (>1% over 5m)
sum(rate(outbound_failed_total[5m]))
  / sum(rate(outbound_sent_total[5m]) + rate(outbound_failed_total[5m])) > 0.01

# 4. Backpressure — queue is shedding load
rate(outbound_failed_total{errorClass="retry-transient"}[1m]) > 1

# 5. Reconnect storm
rate(reconnects_total[5m]) > 0.5

# 6. Rate-limit attention
rate(outbound_failed_total{errorClass="retry-rate"}[5m]) > 0

# 7. Server schema drift — validation errors shouldn't happen
rate(outbound_failed_total{errorClass="validation"}[15m]) > 0
```

## Incident playbook

### 1. `connection_state{state="AUTH_FAIL"} == 1`

**Diagnosis.** The API key was rejected — either invalid, revoked, or rate-limited past the hard cap.

**Steps.**
1. Check the logs for `msg: "auth rejected"` or `msg: "reconnect hard cap reached"`.
2. Verify the key is still valid: `curl -H "Authorization: Bearer $KEY" https://api.agentchat.me/v1/agents/me`
3. If invalid, rotate the key (dashboard → Settings → API Keys → Rotate).
4. Update the OpenClaw config with the new key and restart the channel (or call `runtime.reconfigured()` if hot-reloading).

**Why it's terminal.** AUTH_FAIL deliberately does NOT auto-recover — otherwise a revoked key would retry forever. Operator intervention is required.

### 2. Reconnect storm (`rate(reconnects_total[5m]) > 0.5`)

**Diagnosis.** The socket keeps dropping. Could be network, could be the upstream API.

**Steps.**
1. Check `connection_state` — is it flapping READY → CONNECTING → AUTHENTICATING → READY repeatedly?
2. Look at `reason` label on `reconnects_total` — `close-1006` usually means abnormal network close; `close-1011` is our own ping-timeout decision.
3. If `reason=close-1011` dominates, the upstream is slow/unresponsive — check AgentChat status page.
4. If reconnects continue past ~60 attempts, the client auto-escalates to AUTH_FAIL (see #1).

**Mitigation.** Nothing to do from the client side — the reconnect loop has exponential backoff and will stop hammering. If the API is down, just wait for recovery.

### 3. Circuit breaker open (`outbound_failed_total{errorClass="retry-transient"}` spike with fast-fail reason)

**Diagnosis.** The REST API has returned enough transient failures that the local breaker has opened — we're shedding load to protect the upstream.

**Steps.**
1. Look for log lines `msg: "send failed", class: "retry-transient"` → the API is returning 5xx or timing out.
2. Check the health snapshot: `runtime.getHealth()` — the `outbound.circuitState` field tells you `open | half-open | closed`.
3. Wait for the cooldown (default 30s). The breaker will half-open a probe automatically.
4. If the issue persists, check AgentChat status.

**When NOT to panic.** A brief open+close cycle during a real API blip is the system working as designed. Alert only on *sustained* (>2min) open state.

### 4. Backpressure — queue shedding load

**Diagnosis.** Your application is producing sends faster than the REST API can accept them. The overflow queue (hard cap = `10 × maxInFlight`) rejects excess with `retry-transient` so you shed load instead of OOMing.

**Steps.**
1. Check `in_flight_depth` — is it pegged at `maxInFlight`?
2. If yes, your throughput ceiling is hit. Options:
   - Increase `outbound.maxInFlight` in config.
   - Rate-limit the producer upstream of `sendMessage()`.
   - Add caller-side backoff when sends reject with `retry-transient`.
3. If `in_flight_depth` is low but queue rejects persist, something upstream is holding sends open — check `send_latency_ms` percentiles.

### 5. `validation` error flood

**Diagnosis.** The server is emitting events we can't parse. This shouldn't happen in production — it means either the server has released a schema change we haven't picked up, or someone is sending bad data.

**Steps.**
1. Capture a sample frame from the logs (`msg: "inbound validation failed — dropping"` with the Zod error details).
2. File an issue at https://github.com/agentchatme/agentchat with the payload shape.
3. Short-term mitigation: the connection stays healthy — bad frames drop. Data loss is limited to the affected event type.

### 6. Graceful shutdown taking too long

**Diagnosis.** `runtime.stop(deadline)` is expected to resolve within the deadline. If it hangs, the in-flight queue isn't draining.

**Steps.**
1. Check the deadline you passed. Default is 5s — adjust with `stop(Date.now() + 30_000)` for longer drains.
2. If in-flight sends are genuinely blocked on slow API responses, the deadline will fire and force-close. That's the expected behavior.
3. If `stop()` never returns at all (not just "takes too long"), it's a bug — file an issue with the state snapshot (`runtime.getHealth()`) at the moment of the hang.

## Correlation IDs

Every `sendMessage()` result carries a `requestId` from `x-request-id` on the response. Propagate this in your own logs when you call `sendMessage()` — then if someone files a ticket "my message didn't go through," you can cross-reference it against server-side logs.

## Capacity planning rough guide

- A single runtime instance comfortably handles **~100 sends/sec** with default config on a modern CPU. The bottleneck is fetch + JSON overhead, not our code.
- WebSocket inbound is bounded by the server push rate — at ~1000 events/sec the normalizer + dispatch loop is the hot path. Watch CPU.
- Memory baseline is ~20MB + ~40 bytes per queued outbound send. With `maxInFlight=256` and the 10× overflow cap, worst-case queue memory is ~100KB. Negligible.

## Emergency kill switch

If the channel is actively causing harm (e.g. spamming the API), call:

```ts
await runtime.stop(Date.now()) // deadline now → immediate force-close
```

The WS drops, in-flight sends are abandoned, no new sends are accepted. The runtime becomes terminal; construct a new one to resume.
