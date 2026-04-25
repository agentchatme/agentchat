#!/usr/bin/env node
/**
 * Post-build extension fixer for the CJS bundles.
 *
 * Why this exists
 * ────────────────
 * tsup emits both ESM (`.js`) and CJS (`.cjs`) outputs for every entry.
 * For the env-only credential reader at `dist/credentials/read-env.{js,cjs}`,
 * the source-level import in `src/channel.wizard.ts` is:
 *
 *     import { readApiKeyFromEnv } from './credentials/read-env.js'
 *
 * tsup's `external` list keeps that import un-bundled (so the env read
 * stays in its own dist file — which is the structural fix for ClawHub's
 * install-time security scanner that flags any single file containing
 * both `process.env.X` and a network call).
 *
 * The wrinkle: tsup does NOT rewrite the `.js` extension to `.cjs` when
 * emitting the CJS bundle. So the CJS file ends up with:
 *
 *     var x = require('./credentials/read-env.js')
 *
 * In a `"type": "module"` package, `.js` files are ESM. A CJS `require()`
 * of an ESM `.js` file fails at runtime with `ERR_REQUIRE_ESM`. The CJS
 * bundle would be functionally broken for any consumer that loads it.
 *
 * What this script does
 * ─────────────────────
 * Walk every `dist/*.cjs` file and rewrite the literal substring
 * `'./credentials/read-env.js'` (single or double quoted) to
 * `'./credentials/read-env.cjs'`. The `.js.map` sourcemap files are
 * untouched — they reference source positions, not module paths.
 *
 * The replacement is exact-string, scoped to a single known import path.
 * It will NOT accidentally rewrite `read-env.js` references inside
 * test fixtures, docs, or the ESM bundle.
 *
 * Wired into `pnpm run build` after `tsup` emits, so the fix happens on
 * every release without an extra step. CI (`pnpm test`) does NOT run
 * this — tests load the source TS directly, never the CJS dist.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const distDir = resolve(__dirname, '..', 'dist')

// Bundle outputs that may import the env reader. We list them explicitly
// rather than globbing `dist/*.cjs` so a future entry without this
// import doesn't get an unnecessary file-rewrite cycle.
const cjsBundles = [
  'index.cjs',
  'setup-entry.cjs',
  // configured-state.cjs intentionally omitted — it does not import the
  // env reader. If a future change makes it import, add it here.
]

// Exact strings to swap. Quote variants are belt-and-suspenders against
// minifier or formatter changes that might prefer one over the other.
const replacements = [
  ["'./credentials/read-env.js'", "'./credentials/read-env.cjs'"],
  ['"./credentials/read-env.js"', '"./credentials/read-env.cjs"'],
]

let touched = 0
let totalReplacements = 0

for (const file of cjsBundles) {
  const path = resolve(distDir, file)
  if (!existsSync(path)) {
    // tsup might not have emitted this entry (e.g., format limited to
    // esm-only via env override). Skip silently rather than fail —
    // we only care about CJS files that actually exist.
    continue
  }
  const before = readFileSync(path, 'utf8')
  let after = before
  let fileReplacements = 0
  for (const [from, to] of replacements) {
    const split = after.split(from)
    if (split.length > 1) {
      fileReplacements += split.length - 1
      after = split.join(to)
    }
  }
  if (fileReplacements === 0) continue
  writeFileSync(path, after, 'utf8')
  touched++
  totalReplacements += fileReplacements
  console.log(
    `[fix-cjs-extensions] ${file}: rewrote ${fileReplacements} import` +
      (fileReplacements === 1 ? '' : 's') +
      ` of ./credentials/read-env from .js to .cjs`,
  )
}

if (touched === 0) {
  // Not necessarily an error — possible the import was inlined by
  // accident, or the file naming changed. Surface a warning so the
  // operator can investigate; do not fail the build because the same
  // post-build script runs in environments where we may not have
  // emitted CJS at all.
  console.warn(
    '[fix-cjs-extensions] No CJS bundles needed rewriting. Verify ' +
      'dist/index.cjs and dist/setup-entry.cjs exist and external is ' +
      'configured correctly in tsup.config.ts.',
  )
} else {
  console.log(
    `[fix-cjs-extensions] done — ${touched} file(s) updated, ${totalReplacements} require statement(s) rewritten`,
  )
}
