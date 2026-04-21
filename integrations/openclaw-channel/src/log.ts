/**
 * Structured logger for the channel plugin.
 *
 * Wraps pino with:
 *   - Secret redaction (`apiKey`, `authorization`, `cookie`, `set-cookie` by default)
 *   - A `child({ correlationId })` helper for per-operation logs
 *   - Graceful integration: when OpenClaw's channel runtime context provides
 *     a logger, we delegate to it so logs stream through the gateway's sink.
 *
 * Never logs the API key. Never logs message bodies above `debug` level.
 */

import pino from 'pino'

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  trace(obj: object, msg?: string): void
  debug(obj: object, msg?: string): void
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
  child(bindings: Record<string, unknown>): Logger
}

export interface CreateLoggerOptions {
  level: LogLevel
  redactKeys: readonly string[]
  /** If provided, delegates to the gateway's logger instead of creating our own. */
  delegate?: Logger | undefined
}

export function createLogger(options: CreateLoggerOptions): Logger {
  if (options.delegate) {
    return options.delegate
  }

  const pinoLogger = pino({
    level: options.level,
    base: { plugin: '@agentchatme/openclaw' },
    redact: {
      paths: buildRedactPaths(options.redactKeys),
      censor: '[REDACTED]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  })

  return wrapPino(pinoLogger)
}

function buildRedactPaths(keys: readonly string[]): string[] {
  // Cover common shapes: top-level, nested under `config.*`, nested under
  // `headers.*`, nested under `context.*`. Pino redact paths are JSON-path-ish.
  const prefixes = ['', 'config.', 'headers.', 'context.', 'req.headers.', 'res.headers.']
  const paths: string[] = []
  for (const key of keys) {
    for (const prefix of prefixes) {
      paths.push(`${prefix}${key}`)
    }
  }
  // Also redact under `*` wildcard at top level for deeply nested cases.
  paths.push(...keys.map((k) => `*.${k}`))
  return paths
}

function wrapPino(p: pino.Logger): Logger {
  return {
    trace: (obj, msg) => p.trace(obj, msg),
    debug: (obj, msg) => p.debug(obj, msg),
    info: (obj, msg) => p.info(obj, msg),
    warn: (obj, msg) => p.warn(obj, msg),
    error: (obj, msg) => p.error(obj, msg),
    child: (bindings) => wrapPino(p.child(bindings)),
  }
}

/**
 * Redact a string for display in logs — shows first 8 and last 4 chars,
 * masks the middle. Useful for surfacing "which key" without leaking it.
 */
export function maskSecret(value: string): string {
  if (value.length <= 12) return '[REDACTED]'
  return `${value.slice(0, 8)}••••${value.slice(-4)}`
}
