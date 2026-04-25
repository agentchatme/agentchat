#!/usr/bin/env node
/**
 * Post-build extension fixer for the CJS bundles.
 *
 * tsup emits both ESM (`.js`) and CJS (`.cjs`) outputs and leaves
 * external imports as-is — meaning a literal `'./credentials/read-env.js'`
 * import statement gets carried into both bundle formats. Inside a
 * `"type": "module"` package the `.js` sibling is ESM, so the CJS
 * bundle's `require()` of it would fail with `ERR_REQUIRE_ESM`.
 *
 * This script walks the known CJS bundles after `tsup` finishes and
 * rewrites the literal `'./credentials/read-env.js'` substring (single
 * or double quoted) to `'./credentials/read-env.cjs'`. Sourcemaps are
 * untouched because they reference source positions, not module paths.
 *
 * The replacement is exact-string and scoped to one known import path
 * — it will not rewrite test fixtures, docs, or the ESM bundle. Wired
 * into `pnpm run build` so the swap happens on every release without
 * an extra step. CI does not run this; tests load source TypeScript
 * directly and never the CJS dist.
 *
 * See SECURITY.md ("Defensive separation of credential lookup from
 * outbound I/O") for why the read-env module is a separate dist file
 * in the first place.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const distDir = resolve(__dirname, '..', 'dist')

// Bundle outputs that may import the credential helper. Listed
// explicitly rather than globbing `dist/*.cjs` so a future entry that
// does NOT import the helper does not get an unnecessary file rewrite.
const cjsBundles = [
  'index.cjs',
  'setup-entry.cjs',
  // configured-state.cjs intentionally omitted — it does not import
  // the helper. If a future change makes it import, add it here.
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
    `[fix-cjs-extensions] ${file}: rewrote ${fileReplacements} import` +
      (fileReplacements === 1 ? '' : 's') +
      ` of ./credentials/read-env from .js to .cjs`,
  )
}

if (touched === 0) {
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
