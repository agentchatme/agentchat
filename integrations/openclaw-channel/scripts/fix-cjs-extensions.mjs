#!/usr/bin/env node
/**
 * Post-build extension fixer for the CJS bundles.
 *
 * tsup emits both ESM (`.js`) and CJS (`.cjs`) outputs and leaves
 * external imports untouched — meaning a literal `'./credentials/read-env.js'`
 * import statement gets carried into both bundle formats. Inside a
 * `"type": "module"` package the `.js` sibling is ESM, so the CJS
 * bundle's `require()` of it would fail with `ERR_REQUIRE_ESM`.
 *
 * This script walks the known CJS bundles after `tsup` finishes and
 * rewrites each external sibling-import literal from `.js` to `.cjs`.
 * Sourcemaps are untouched because they reference source positions,
 * not module paths.
 *
 * The replacement is exact-string and scoped to the known external
 * paths — it will not rewrite test fixtures, docs, or the ESM bundles.
 * Wired into `pnpm run build` so the swap happens on every release
 * without an extra step. CI does not run this; tests load source
 * TypeScript directly and never the CJS dist.
 *
 * See SECURITY.md ("Defensive separation of credential lookup from
 * outbound I/O") for why these helpers are separate dist files in
 * the first place.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const distDir = resolve(__dirname, '..', 'dist')

// CJS bundles that may import an externalized helper. Listed
// explicitly rather than globbing `dist/**/*.cjs` so a future entry
// that does NOT consume any external helper does not get an
// unnecessary file rewrite. New consumers MUST be added here.
const cjsBundles = [
  'index.cjs',
  'setup-entry.cjs',
  // agents-anchor.cjs imports `../credentials/read-env.js` — needs
  // the same swap applied to its single sibling require.
  'binding/agents-anchor.cjs',
  // configured-state.cjs intentionally omitted — it does not import
  // any external helper. If a future change makes it import one,
  // add it here.
]

// Exact import-specifier swaps. Both quote styles are listed as
// belt-and-suspenders against minifier or formatter changes.
//
// New external helpers MUST add their `.js → .cjs` swap here so the
// CJS bundles produced by tsup actually resolve at runtime.
const replacements = [
  // Credential helper — sibling-relative (used by index/setup-entry)
  // and parent-relative (used by binding/agents-anchor.cjs).
  ["'./credentials/read-env.js'", "'./credentials/read-env.cjs'"],
  ['"./credentials/read-env.js"', '"./credentials/read-env.cjs"'],
  ["'../credentials/read-env.js'", "'../credentials/read-env.cjs'"],
  ['"../credentials/read-env.js"', '"../credentials/read-env.cjs"'],
  // AGENTS.md anchor — only sibling-relative form is used today.
  ["'./binding/agents-anchor.js'", "'./binding/agents-anchor.cjs'"],
  ['"./binding/agents-anchor.js"', '"./binding/agents-anchor.cjs"'],
]

let touched = 0
let totalReplacements = 0

for (const file of cjsBundles) {
  const path = resolve(distDir, file)
  if (!existsSync(path)) {
    // tsup might not have emitted this entry. Skip silently rather
    // than fail — we only care about CJS files that actually exist.
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
    `[fix-cjs-extensions] ${file}: rewrote ${fileReplacements} external require` +
      (fileReplacements === 1 ? '' : 's') +
      ' from .js to .cjs',
  )
}

if (touched === 0) {
  console.warn(
    '[fix-cjs-extensions] No CJS bundles needed rewriting. Verify ' +
      'dist/index.cjs, dist/setup-entry.cjs, and dist/binding/agents-anchor.cjs ' +
      'exist and the `external` list in tsup.config.ts is configured correctly.',
  )
} else {
  console.log(
    `[fix-cjs-extensions] done — ${touched} file(s) updated, ${totalReplacements} require statement(s) rewritten`,
  )
}
