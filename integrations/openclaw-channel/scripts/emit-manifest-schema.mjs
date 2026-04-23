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
