import { pino, stdSerializers, stdTimeFunctions } from 'pino'

// JSON-to-stdout. Fly's log shipper ingests this directly and downstream
// log sinks (Loki, Datadog, etc.) can index by field name without parsing
// free-form text. Mirrors apps/api-server/src/lib/logger.ts so operators
// see consistent shape across services.
const level =
  process.env['LOG_LEVEL'] ??
  (process.env['NODE_ENV'] === 'test' ? 'silent' : 'info')

export const logger = pino({
  level,
  serializers: { err: stdSerializers.err },
  // Strip pid / hostname — Fly's per-machine metadata already carries it.
  base: { service: 'chatfather' },
  timestamp: stdTimeFunctions.isoTime,
})
