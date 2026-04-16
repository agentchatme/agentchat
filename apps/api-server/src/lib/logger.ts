import { pino, stdSerializers, stdTimeFunctions } from 'pino'

// Process-wide structured logger. JSON output to stdout — the Fly.io log
// shipper picks it up directly and any downstream sink (Loki, Datadog,
// Grafana Cloud Logs) can index by field name without parsing free-form
// text. Level controlled by LOG_LEVEL env (default 'info'). NODE_ENV=test
// suppresses to 'silent' so vitest output stays clean.

const level =
  process.env['LOG_LEVEL'] ??
  (process.env['NODE_ENV'] === 'test' ? 'silent' : 'info')

export const logger = pino({
  level,
  // Sentry already captures errors; pino's serializer for `err` keys gives
  // us the stack in JSON for log-only contexts (e.g. claim failures the
  // worker swallows after recording metrics).
  serializers: {
    err: stdSerializers.err,
  },
  // Strip pid / hostname noise — Fly machines have stable ids in their own
  // log metadata, repeating it per line just bloats payloads.
  base: undefined,
  timestamp: stdTimeFunctions.isoTime,
})

/** Bind a child logger with stable fields (request_id, agent_id, etc.).
 *  Use this in handlers so every line they emit is automatically tagged. */
export function childLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings)
}
