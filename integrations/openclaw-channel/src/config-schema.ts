/**
 * Zod schema for AgentChat channel config.
 *
 * Source of truth: this file. The JSON Schema inlined in `openclaw.plugin.json`
 * MUST stay in sync (P1 adds a build step that emits it via zod-to-json-schema).
 *
 * `.strict()` rejects unknown keys — a common source of "the config silently
 * ignored my setting" bugs.
 */

import { z } from 'zod'

export const reconnectConfigSchema = z
  .object({
    initialBackoffMs: z.number().int().min(100).max(10_000).default(1_000),
    maxBackoffMs: z.number().int().min(1_000).max(300_000).default(30_000),
    jitterRatio: z.number().min(0).max(1).default(0.2),
  })
  .strict()

export const pingConfigSchema = z
  .object({
    intervalMs: z.number().int().min(5_000).max(120_000).default(30_000),
    timeoutMs: z.number().int().min(1_000).max(30_000).default(10_000),
  })
  .strict()

export const outboundConfigSchema = z
  .object({
    maxInFlight: z.number().int().min(1).max(10_000).default(256),
    sendTimeoutMs: z.number().int().min(1_000).max(60_000).default(15_000),
  })
  .strict()

export const observabilityConfigSchema = z
  .object({
    logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
    redactKeys: z
      .array(z.string())
      .default(['apiKey', 'authorization', 'cookie', 'set-cookie']),
  })
  .strict()

export const agentHandleSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
    'handle must be lowercase letters/digits/hyphens; start with a letter; no trailing or doubled hyphens',
  )
  .min(3, 'handle must be at least 3 characters')
  .max(30, 'handle must be at most 30 characters')

export const agentchatChannelConfigSchema = z
  .object({
    apiBase: z.string().url().default('https://api.agentchat.me'),
    apiKey: z.string().min(20, 'apiKey looks too short for an AgentChat API key'),
    agentHandle: agentHandleSchema.optional(),
    // `.prefault({})` — Zod 4 idiom: when the key is missing from input, parse
    // `{}` through the inner schema so its own per-field defaults kick in.
    // Using `.default({})` here fails in Zod 4 because the output type's fields
    // are non-optional once the inner schema has defaults.
    reconnect: reconnectConfigSchema.prefault({}),
    ping: pingConfigSchema.prefault({}),
    outbound: outboundConfigSchema.prefault({}),
    observability: observabilityConfigSchema.prefault({}),
  })
  .strict()

export type AgentchatChannelConfig = z.infer<typeof agentchatChannelConfigSchema>
export type AgentchatChannelConfigInput = z.input<typeof agentchatChannelConfigSchema>

/**
 * Parse + validate config at plugin startup.
 *
 * Strict on `apiKey` and the four nested groups — `parseChannelConfig` is
 * called only AFTER `resolveAgentchatAccount` has confirmed that the
 * persisted config block is non-empty (see `channel.ts`), so an empty
 * install-time config never reaches Zod. The runtime-time strictness here
 * surfaces typos and out-of-range values fast. The OpenClaw install-time
 * JSON Schema (emitted by `scripts/emit-manifest-schema.mjs`) is more
 * permissive — see that script's post-process step for the rationale —
 * so a freshly-installed plugin can pass install validation against an
 * empty config block before the setup wizard fills in credentials.
 *
 * `AgentChatChannelError` wraps validation failures so the gateway can
 * classify them (`terminal-user` — operator fix required).
 */
export function parseChannelConfig(input: unknown): AgentchatChannelConfig {
  return agentchatChannelConfigSchema.parse(input)
}
