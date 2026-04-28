#!/usr/bin/env node
/**
 * Regression test: verifies that the **source** package.json's runtime
 * dependencies are all `npm install`-able by raw npm — the same way
 * ClawHub source-linked builds run them.
 *
 * Why:
 *   The published npm tarball is post-processed by `prepack`
 *   (devDeps stripped, peerDeps stripped). ClawHub source-linked plugins
 *   skip that path entirely — they zip our source tree and run
 *   `npm install` on it directly. If the source has any spec npm doesn't
 *   understand (workspace:, file:, link:, catalog:), the install fails
 *   with EUNSUPPORTEDPROTOCOL — and OpenClaw's `--silent` flag (until
 *   that's fixed upstream) swallows the error so the user sees only
 *   "npm install failed:".
 *
 *   The 0.6.2 release shipped this bug. This test ensures the next one
 *   never can.
 *
 * What it does:
 *   1. Reads the source package.json.
 *   2. Walks each spec in `dependencies`, `peerDependencies`, and
 *      `optionalDependencies` (`devDependencies` is intentionally
 *      excluded — `npm install --omit=dev` skips it, and dev tools
 *      can legitimately use any spec form).
 *   3. Fails if any runtime spec uses a protocol npm cannot resolve from
 *      the registry: `workspace:`, `file:`, `link:`, `catalog:`. These
 *      work in the source monorepo (pnpm rewrites `workspace:` at pack
 *      time for the npm tarball) but reach end-user machines verbatim
 *      via ClawHub source-linked builds and crash there.
 *
 *   Pure string parsing — no subprocess, no network, no `npm install`.
 *   Same coverage as a `npm install --dry-run` for the specific bug
 *   class that surfaced for `@agentchatme/openclaw@0.6.2`.
 *
 * Wire-up: this runs as part of `prepublishOnly`. A future commit that
 * re-introduces a `workspace:`/`file:`/`link:`/`catalog:` spec in any
 * runtime-dependency section cannot reach npm or ClawHub.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(scriptDir, '..')
const packageJsonPath = resolve(pkgRoot, 'package.json')

const log = (msg) => console.log(`[verify-source-installs] ${msg}`)
const err = (msg) => console.error(`[verify-source-installs] ${msg}`)

let pkg
try {
  pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
} catch (e) {
  err(`could not read/parse ${packageJsonPath}: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
}

const NON_PORTABLE_PREFIXES = ['workspace:', 'file:', 'link:', 'catalog:']
const RUNTIME_SECTIONS = ['dependencies', 'peerDependencies', 'optionalDependencies']

const offenders = []
for (const section of RUNTIME_SECTIONS) {
  const entries = pkg[section]
  if (!entries || typeof entries !== 'object') continue
  for (const [name, spec] of Object.entries(entries)) {
    if (typeof spec !== 'string') continue
    const bad = NON_PORTABLE_PREFIXES.find((p) => spec.startsWith(p))
    if (bad) offenders.push(`  ${section}["${name}"] = "${spec}"  (uses non-portable "${bad}" protocol)`)
  }
}

if (offenders.length > 0) {
  err(`FAILED — source package.json has ${offenders.length} non-portable runtime-dependency spec(s):`)
  for (const line of offenders) err(line)
  err('')
  err('These specs work in the source monorepo (pnpm rewrites `workspace:` at')
  err('pack time for the npm tarball) but reach end-user machines verbatim via')
  err('ClawHub source-linked builds, where raw npm install crashes with')
  err('EUNSUPPORTEDPROTOCOL. Replace each with a real semver range.')
  process.exit(1)
}

log(`OK — ${RUNTIME_SECTIONS.join(', ')} are all npm-installable`)
