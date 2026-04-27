#!/usr/bin/env node
/**
 * Build-time sync: emit `openclaw.plugin.json#configSchema` (+ `#uiHints`)
 * from the canonical Zod source in `src/config-schema.ts`.
 *
 * Why:
 *   The plugin manifest is consumed by OpenClaw's install-time registry
 *   BEFORE any plugin code runs (so the registry can validate config without
 *   loading the plugin's JS). The runtime plugin also carries a
 *   `configSchema` built by `buildChannelConfigSchema(zodSchema)`. Those two
 *   shapes MUST agree — otherwise a manifest-valid config can fail at runtime
 *   or vice-versa. Rather than hand-maintain both, we generate the manifest
 *   from the same SDK function that produces the runtime schema.
 *
 * Contract:
 *   - Runs after `tsup` (so `dist/channel.js` + `dist/config-schema.js` exist).
 *   - Reads `openclaw.plugin.json`, replaces `configSchema` + `uiHints`,
 *     writes back with stable 2-space formatting + trailing newline.
 *   - Exits non-zero if the built plugin doesn't expose `configSchema`.
 *
 * CI guarantee: if a dev edits Zod without re-running build, the manifest
 * is stale — `prepublishOnly` catches it by running build before publish.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(scriptDir, '..')
const manifestPath = resolve(pkgRoot, 'openclaw.plugin.json')
const packageJsonPath = resolve(pkgRoot, 'package.json')
// tsup only emits the entrypoints in `tsup.config.ts` (index / setup-entry /
// configured-state). The `channel.ts` module is inlined into `dist/index.js`,
// which also re-exports `agentchatPlugin` — so we load from there.
const builtPluginPath = resolve(pkgRoot, 'dist', 'index.js')

function fail(msg) {
  console.error(`[emit-manifest-schema] ${msg}`)
  process.exit(1)
}

const pluginModule = await import(pathToFileURL(builtPluginPath).href).catch((err) => {
  fail(
    `could not import built plugin at ${builtPluginPath} — did you run 'pnpm build' first?\n  ${err.message}`,
  )
})

const plugin = pluginModule.agentchatPlugin
if (!plugin || typeof plugin !== 'object') {
  fail(`imported module does not export 'agentchatPlugin' from dist/index.js`)
}

const configSchema = plugin.configSchema
if (!configSchema || typeof configSchema !== 'object') {
  fail(`plugin.configSchema is missing or not an object`)
}
if (!configSchema.schema || typeof configSchema.schema !== 'object') {
  fail(`plugin.configSchema.schema is missing or not an object`)
}

const manifestRaw = readFileSync(manifestPath, 'utf8')
let manifest
try {
  manifest = JSON.parse(manifestRaw)
} catch (err) {
  fail(`could not parse manifest at ${manifestPath}: ${err.message}`)
}

// Keep the manifest version in lockstep with package.json. The manifest
// `version` field is informational (per OpenClaw docs) but operators
// surface it in `openclaw channels status`, and a drift between the
// advertised version and the installed tarball is confusing. Syncing here
// means a single `pnpm build` after a version bump re-stamps the manifest.
try {
  const pkgRaw = readFileSync(packageJsonPath, 'utf8')
  const pkg = JSON.parse(pkgRaw)
  if (typeof pkg.version === 'string' && pkg.version.length > 0) {
    manifest.version = pkg.version
  }
} catch (err) {
  fail(`could not read package.json version: ${err.message}`)
}

// Strip `$schema` / any top-level key starting with `$` from the config
// schema before writing. Zod's JSON-Schema converter includes
// `"$schema": "http://json-schema.org/draft-07/schema#"` by convention,
// but ClawHub's publish backend (Convex) rejects any field starting with
// `$` as reserved (`Field name $schema starts with a '$', which is
// reserved.`). The $schema marker is purely documentary — consumers know
// the shape is JSON Schema without it — so dropping it is safe.
const cleanedSchema = { ...configSchema.schema }
for (const key of Object.keys(cleanedSchema)) {
  if (key.startsWith('$')) delete cleanedSchema[key]
}

// Loosen the install-time `required` array so OpenClaw's manifest
// validator accepts an empty config block. OpenClaw runs JSON Schema
// validation on the persisted plugin entry at install time —
// **before** the setup wizard fills in `apiKey` and `agentHandle` —
// so a strict required array blocks the install with
// `must have required property 'apiKey'`. The runtime is gated separately
// by the `configuredState` predicate (`hasAgentChatConfiguredState`),
// which enforces apiKey + agentHandle presence before the channel ever
// connects. Two layers, two jobs:
//
//   - JSON Schema (this file): describes the SHAPE of valid config,
//     permissive about presence so install-time validation can pass
//     against `{}`.
//   - configuredState predicate + Zod schema (`config-schema.ts`):
//     enforces "ready to run" at runtime. Strict.
//
// What stays in `required`: nothing. Every top-level field either has
// a leaf-level `default` that OpenClaw auto-fills (`apiBase`) or has
// a prefault `{}` at the runtime layer that fills in nested defaults
// when the plugin starts (`reconnect` / `ping` / `outbound` /
// `observability`) or is gated by `configuredState` (`apiKey`,
// `agentHandle`). An empty install-time `required` means a fresh-out-
// of-the-box config block validates without prejudging which fields
// the user has filled in yet.
//
// We deliberately do NOT push `default: {}` onto the nested-object
// subschemas. JSON Schema validators differ on whether they descend
// into a defaulted object and revalidate its inner `required` array —
// a permissive validator that auto-fills `reconnect: {}` and then
// fails on the inner `required: ['initialBackoffMs', ...]` would
// reintroduce the install-time blocker. Leaving the nested objects
// truly absent from input means the inner schemas never run during
// install validation; the runtime parser (Zod) materializes the
// nested defaults via `.prefault({})` when the plugin actually starts.
//
// This post-process replaces an earlier mis-design where the Zod schema
// alone described the strict shape, the JSON Schema inherited that
// strictness, and `openclaw plugins install` failed at the persist step
// with `must have required property 'apiKey'`. See plugin CHANGELOG
// 0.6.4 for the full root cause writeup.
if (cleanedSchema.required) {
  delete cleanedSchema.required
}

// Emit `channelConfigs.agentchat` for the pre-runtime config-schema +
// setup-surface introspection path that OpenClaw 2026.4.24+ expects.
//
// Why both top-level `configSchema` and per-channel `channelConfigs`:
// OpenClaw's manifest registry treats `channelConfigs[id]` as the
// canonical source of channel-level schema/uiHints (winning over
// runtime-collected metadata for community plugins, which are loaded
// with `origin: "global"`); the top-level `configSchema` is only
// consumed for plugin-level (non-channel) settings. Without a
// `channelConfigs.agentchat` block, OpenClaw emits the
// `without channelConfigs metadata` warning at install time AND has
// to load the plugin's JS to surface the config form — defeating the
// "introspect schema before runtime loads" guarantee. With it, the
// install is silent and the config form renders pre-load.
//
// We deliberately copy the same cleanedSchema into both surfaces:
//   - `manifest.configSchema` stays as a stub-shaped backstop for
//     older OpenClaw versions that haven't been taught to prefer
//     channelConfigs yet (purely backward-compat — newer versions
//     read channelConfigs first).
//   - `manifest.channelConfigs.agentchat.schema` carries the same
//     loosened shape so the pre-runtime path validates identically.
//
// Single source of truth: the runtime Zod export. Both manifest
// surfaces are derived from it in this script. A drift between them
// is structurally impossible.
const CHANNEL_ID = 'agentchat'
const channelConfigEntry = {
  schema: cleanedSchema,
}
if (configSchema.uiHints) {
  channelConfigEntry.uiHints = configSchema.uiHints
}
manifest.channelConfigs = {
  ...(manifest.channelConfigs ?? {}),
  [CHANNEL_ID]: channelConfigEntry,
}

manifest.configSchema = cleanedSchema
if (configSchema.uiHints) {
  manifest.uiHints = configSchema.uiHints
} else {
  delete manifest.uiHints
}

const nextRaw = `${JSON.stringify(manifest, null, 2)}\n`

if (nextRaw === manifestRaw) {
  console.log('[emit-manifest-schema] manifest already in sync — no write')
  process.exit(0)
}

writeFileSync(manifestPath, nextRaw, 'utf8')
console.log(`[emit-manifest-schema] wrote ${manifestPath}`)
