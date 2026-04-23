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

/**
 * Pull the YAML frontmatter body out of a SKILL.md regardless of line
 * endings. `autocrlf=true` Windows checkouts land CRLFs in the file;
 * the original index-based slice (`indexOf('\n---\n', 4)`) was
 * EOL-sensitive and silently returned an empty string on Windows.
 */
function extractFrontmatter(md: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(md)
  return match ? match[1] : ''
}

describe('bundled agentchat skill', () => {
  const text = readFileSync(skillPath, 'utf8')

  it('starts with a YAML frontmatter block', () => {
    // Line-ending tolerant: Windows checkouts may have CRLF if git's
    // `autocrlf` is on. Either is fine on-disk; the npm tarball contents
    // are what reach consumers, and tar/npm don't mangle EOLs.
    expect(text).toMatch(/^---\r?\n/)
    expect(text).toMatch(/\r?\n---\r?\n/)
  })

  it('declares name=agentchat and a substantive description', () => {
    const fm = extractFrontmatter(text)
    expect(fm).toMatch(/^name:\s*agentchat\s*$/m)
    expect(fm).toMatch(/^description:\s+.{30,}/m)
  })

  it('is gated on channels.agentchat via metadata.openclaw.requires.config', () => {
    const fm = extractFrontmatter(text)
    // Tolerant of either inline-JSON (`"requires": { "config": [...] }`) or
    // nested-YAML (`requires:\n  config: [...]`) frontmatter shapes. The
    // invariant the gate depends on is: the substring `requires` appears,
    // followed somewhere below by `config: [... channels.agentchat ...]`.
    // `config` may be quoted (JSON form) or bare (YAML form) — accept both.
    expect(fm).toMatch(
      /requires[\s\S]*?["']?config["']?\s*:\s*\[\s*["']?channels\.agentchat["']?\s*\]/,
    )
  })

  it('covers the core etiquette topics', () => {
    // Spot-check that the main sections exist — sanity guard against an
    // empty or truncated file. These headings are the stable anchors in
    // the current skill; change them here if the skill structure moves.
    expect(text).toMatch(/##\s+What the runtime handles for you/)
    expect(text).toMatch(/##\s+What you can actually do/)
    expect(text).toMatch(/###\s+Inbox and navigation/)
    expect(text).toMatch(/###\s+Directory and discovery/)
    expect(text).toMatch(/###\s+Contacts \(/)
    expect(text).toMatch(/###\s+Hard exits: blocks, reports, mutes/)
    expect(text).toMatch(/###\s+Groups \(/)
    expect(text).toMatch(/###\s+Presence and availability/)
    expect(text).toMatch(/###\s+Platform support/)
    expect(text).toMatch(/##\s+The chat rules, explicitly/)
    expect(text).toMatch(/##\s+Error codes you will see/)
    // Platform-first behavioral sections — these are what separate us from
    // a gateway-style plugin. If any of these go missing, the agent loses
    // the norms that make them a trusted peer vs. a noisy one.
    expect(text).toMatch(/##\s+Checking in on your network/)
    expect(text).toMatch(/##\s+When to reply, when to stay silent/)
    expect(text).toMatch(/##\s+Inbox triage: a cold DM arrives/)
    expect(text).toMatch(/##\s+Initiating proactively/)
    expect(text).toMatch(/##\s+Group dynamics/)
    expect(text).toMatch(/##\s+Relationship memory: contacts/)
    expect(text).toMatch(/##\s+Presence as communication/)
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
