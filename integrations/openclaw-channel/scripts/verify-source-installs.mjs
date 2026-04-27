#!/usr/bin/env node
/**
 * Regression test: verifies that the **source** package.json is
 * `npm install`-able by raw npm — the same way ClawHub source-linked
 * builds run it.
 *
 * Why:
 *   The published npm tarball is post-processed by `prepack`
 *   (devDeps stripped, peerDeps stripped). ClawHub source-linked plugins
 *   skip that path entirely — they zip our source tree and run
 *   `npm install` on it directly. If the source has any spec npm doesn't
 *   understand (workspace:, file:, link:, catalog:), the install fails
 *   with EUNSUPPORTEDPROTOCOL — and OpenClaw's `--silent` flag swallows
 *   the error so the user sees only "npm install failed:".
 *
 *   The 0.6.2 release shipped this bug. This test ensures the next one
 *   never can.
 *
 * What it does:
 *   1. Copies the package.json into a fresh temp dir.
 *   2. Runs `npm install --dry-run --omit=dev --ignore-scripts ...` in
 *      that dir — the same flags ClawHub-side OpenClaw uses (minus
 *      --silent, since we want to see errors).
 *   3. Exits non-zero if npm rejects the manifest.
 *
 *   --dry-run does the resolve step (where workspace:/file:/link: errors
 *   surface) without writing node_modules, so the test is fast.
 *
 *  Wire-up: this runs as part of `prepublishOnly`. A future commit that
 *  re-introduces a workspace: spec cannot reach npm or ClawHub.
 */

import { mkdtemp, copyFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(scriptDir, '..')
const packageJsonPath = resolve(pkgRoot, 'package.json')

const log = (msg) => console.log(`[verify-source-installs] ${msg}`)
const err = (msg) => console.error(`[verify-source-installs] ${msg}`)

const workDir = await mkdtemp(join(tmpdir(), 'verify-source-install-'))
try {
  await copyFile(packageJsonPath, join(workDir, 'package.json'))
  log(`copied source package.json → ${workDir}`)

  log('running: npm install --dry-run --omit=dev --ignore-scripts --no-package-lock --no-audit --no-fund')
  const result = spawnSync(
    'npm',
    [
      'install',
      '--dry-run',
      '--omit=dev',
      '--ignore-scripts',
      '--no-package-lock',
      '--no-audit',
      '--no-fund',
    ],
    {
      cwd: workDir,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    },
  )

  if (result.status !== 0) {
    err(`FAILED — npm rejected the source package.json (exit ${result.status})`)
    err('The source package.json is not installable by raw npm.')
    err('This breaks ClawHub source-linked builds and any consumer cloning the repo.')
    err('Common causes: workspace:, file:, link:, catalog: specs in `dependencies`.')
    err('Fix: rewrite the offending spec to a real semver range and rerun.')
    process.exit(1)
  }

  log('OK — source package.json is npm-installable')
} finally {
  await rm(workDir, { recursive: true, force: true })
}
