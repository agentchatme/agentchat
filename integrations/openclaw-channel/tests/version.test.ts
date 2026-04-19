/**
 * Version pin — the `PACKAGE_VERSION` constant is used by the HTTP user-agent
 * string, so it MUST match `package.json`'s `version` field. Divergence
 * silently lies to the server (and to anyone grepping access logs for a bad
 * release). Keep them pinned via this test.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PACKAGE_VERSION } from '../src/version.js'

describe('PACKAGE_VERSION', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8'),
    ) as { version: string }
    expect(PACKAGE_VERSION).toBe(pkg.version)
  })
})
