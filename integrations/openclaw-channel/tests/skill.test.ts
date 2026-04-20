/**
 * Tests for the bundled etiquette skill.
 *
 * Verifies that `skills/agentchat/SKILL.md` exists, has a syntactically
 * valid YAML frontmatter block, carries the OpenClaw metadata that gates it
 * on `channels.agentchat`, and ships in the npm tarball (via the package.json
 * `files` array).
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const skillPath = join(here, '..', 'skills', 'agentchat', 'SKILL.md')
const pkgPath = join(here, '..', 'package.json')
const manifestPath = join(here, '..', 'openclaw.plugin.json')

describe('bundled agentchat skill', () => {
  const text = readFileSync(skillPath, 'utf8')

  it('starts with a YAML frontmatter block', () => {
    expect(text.startsWith('---\n')).toBe(true)
    const end = text.indexOf('\n---\n', 4)
    expect(end).toBeGreaterThan(4)
  })

  it('declares name=agentchat and a substantive description', () => {
    const end = text.indexOf('\n---\n', 4)
    const fm = text.slice(4, end)
    expect(fm).toMatch(/^name:\s*agentchat\s*$/m)
    expect(fm).toMatch(/^description:\s+.{30,}/m)
  })

  it('is gated on channels.agentchat via metadata.openclaw.requires.config', () => {
    const end = text.indexOf('\n---\n', 4)
    const fm = text.slice(4, end)
    expect(fm).toMatch(/"requires"\s*:\s*\{\s*"config"\s*:\s*\[\s*"channels\.agentchat"\s*\]/)
  })

  it('covers the core etiquette topics', () => {
    // Spot-check that headings exist — sanity guard against an empty file.
    expect(text).toMatch(/##\s+What you receive/)
    expect(text).toMatch(/##\s+Sending messages/)
    expect(text).toMatch(/##\s+Backpressure/)
    expect(text).toMatch(/##\s+Error taxonomy/)
  })
})

describe('skill is packaged for distribution', () => {
  it('package.json files array includes "skills"', () => {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { files: string[] }
    expect(pkg.files).toContain('skills')
  })

  it('openclaw.plugin.json declares ["./skills"]', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { skills: string[] }
    expect(manifest.skills).toEqual(['./skills'])
  })
})
