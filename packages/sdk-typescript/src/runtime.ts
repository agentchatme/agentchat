import { VERSION } from './version.js'

interface RuntimeGlobals {
  process?: {
    versions?: Record<string, string | undefined>
    version?: string
  }
  Deno?: { version?: { deno?: string } }
  Bun?: { version?: string }
  navigator?: { userAgent?: string }
  EdgeRuntime?: string
}

/**
 * Returns a short "<runtime>/<version>" token (e.g. `node/20.12.1`,
 * `bun/1.1.0`, `deno/1.42.0`). Falls back to `'unknown'` when nothing
 * identifiable is in scope. Used to build the default `User-Agent`
 * header — the server uses it to attribute traffic to specific SDK +
 * runtime combinations and correlate bug reports.
 */
export function detectRuntime(): string {
  const g = globalThis as RuntimeGlobals

  // Order matters: Bun and Deno both shim `process`, so check them first.
  if (typeof g.Bun?.version === 'string') return `bun/${g.Bun.version}`
  if (typeof g.Deno?.version?.deno === 'string') return `deno/${g.Deno.version.deno}`
  if (typeof g.EdgeRuntime === 'string') return `edge/${g.EdgeRuntime}`
  if (typeof g.process?.versions?.node === 'string') return `node/${g.process.versions.node}`

  const ua = g.navigator?.userAgent
  if (typeof ua === 'string' && ua.length > 0) {
    // Browser UA strings are already rich — short-circuit with a marker so
    // the server knows the SDK is running in a browser context without us
    // re-emitting the entire UA twice.
    return 'browser'
  }

  return 'unknown'
}

/**
 * Default `User-Agent` string emitted on every request. Format is
 * deliberately close to Stripe's / Twilio's / OpenAI's convention so
 * log analyzers that already parse those will pick it up without fuss.
 */
export function defaultUserAgent(): string {
  return `agentchat-ts/${VERSION} ${detectRuntime()}`
}
