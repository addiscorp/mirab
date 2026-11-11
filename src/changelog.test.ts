// CHANGELOG.md as the release workflows read it (scripts/changelog.ts):
// promote.yml's release body, release.yml's canary notes, and CI's check.
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  ChangelogError,
  changelogProblem,
  changelogSection,
  releaseNotes,
} from '../scripts/changelog'
import pkg from '../package.json'

const LOG = `# Changelog

## 0.3.0 (unreleased)

### Breaking

### Changed

- None.

## 0.2.10

### Added

- \`mirab ten\`.

## 0.2.1

### Breaking

- \`NETWORK_SETUP\` is now a string: before \`"sudo scripts/x"\`, after \`"sudo mirab …"\`.

### Upgrade notes

1. Re-run \`sudo mirab vm network setup\`.

## 0.2.0

- First release.
`

describe('a version section', () => {
  test('present: its body, up to the next version, and only that version', () => {
    const body = changelogSection(LOG, '0.2.1')
    expect(body).toStartWith('### Breaking')
    expect(body).toContain('Re-run `sudo mirab vm network setup`')
    expect(body).not.toContain('0.2.0')
    expect(body).not.toContain('First release')
    // 0.2.1 is not 0.2.10, nor the other way round.
    expect(changelogSection(LOG, '0.2.10')).toBe('### Added\n\n- `mirab ten`.')
  })

  test('missing: refused, naming the version', () => {
    expect(() => changelogSection(LOG, '0.2.2')).toThrow(ChangelogError)
    expect(() => changelogSection(LOG, '0.2.2')).toThrow(
      'CHANGELOG.md has no "## 0.2.2" section',
    )
    expect(() => changelogSection('', '0.2.1')).toThrow(/no "## 0.2.1"/)
  })

  test('empty: only headings, blank lines or "None" are refused', () => {
    expect(() => changelogSection(LOG, '0.3.0')).toThrow(
      `CHANGELOG.md's "## 0.3.0" section is empty`,
    )
    expect(() =>
      changelogSection('## 0.4.0\n\n<!-- entries -->\n## 0.3.9\n- x', '0.4.0'),
    ).toThrow(/is empty/)
  })
})

describe('release notes', () => {
  test('stable: the section and the install line; a missing or empty section stops the promotion', () => {
    const notes = releaseNotes(LOG, '0.2.1')
    expect(notes).toStartWith('### Breaking')
    expect(notes).toEndWith(
      'Install: `curl -fsSL https://mirab-releases.addis.gg/install.sh | sh`\n',
    )
    expect(() => releaseNotes(LOG, '0.2.2')).toThrow(/no "## 0.2.2"/)
    expect(() => releaseNotes(LOG, '0.3.0')).toThrow(/is empty/)
  })

  test('canary: marked as one, with the section so far, or a note that there is none yet', () => {
    const canary = { tag: 'v0.2.1-canary-abc1234', commit: 'abc1234def' }
    const notes = releaseNotes(LOG, '0.2.1', canary)
    expect(notes).toStartWith('**Canary** v0.2.1-canary-abc1234')
    expect(notes).toContain('Not a stable release')
    expect(notes).toContain('Re-run `sudo mirab vm network setup`')
    expect(notes).toContain('| sh -s -- --canary`')
    expect(releaseNotes(LOG, '0.3.0', canary)).toContain(
      '_No CHANGELOG.md entries for 0.3.0 yet._',
    )
  })

  test('the CLI promote.yml runs: exit 1 and the reason when the section is missing or empty', async () => {
    await mkdir(resolve('.tmp'), { recursive: true })
    const dir = await mkdtemp(join(resolve('.tmp'), 'changelog-'))
    const file = join(dir, 'CHANGELOG.md')
    await writeFile(file, LOG)
    const run = (...args: string[]) =>
      spawnSync('bun', ['scripts/changelog.ts', ...args], {
        cwd: resolve(import.meta.dir, '..'),
        encoding: 'utf8',
      })
    const ok = run('notes', '0.2.1', file)
    expect(ok.status).toBe(0)
    expect(ok.stdout).toBe(releaseNotes(LOG, '0.2.1'))
    for (const v of ['0.2.2', '0.3.0']) {
      const r = run('notes', v, file)
      expect(r.status).toBe(1)
      expect(r.stdout).toBe('')
      expect(r.stderr).toMatch(new RegExp(`changelog: .*"## ${v}"`))
    }
    const c = run(
      'notes',
      '0.3.0',
      file,
      '--canary',
      'v0.3.0-canary-1',
      'c0ffee',
    )
    expect(c.status).toBe(0)
    expect(c.stdout).toContain('**Canary** v0.3.0-canary-1')
  })
})

describe("CI's changelog check", () => {
  const before = '## 0.2.1\n\n### Added\n\n- one\n'
  const after = before + '- two\n'
  test('a change to what mirab ships needs an entry under the current version', () => {
    for (const f of [
      'src/mirab.ts',
      'guest-agent/kernel-x86_64.config',
      'scripts/vm-release.ts',
      'vz/main.swift',
      'install.sh',
      'types/index.d.ts',
    ])
      expect(
        changelogProblem({
          changed: [f],
          version: '0.2.1',
          before,
          after: before,
        }),
      ).toContain(f)
    expect(
      changelogProblem({
        changed: ['src/a.ts'],
        version: '0.2.1',
        before,
        after,
      }),
    ).toBeUndefined()
  })

  test('an entry under another version does not count; a version bump that opens its section does', () => {
    const elsewhere = before + '\n## 0.2.0\n\n- also\n'
    expect(
      changelogProblem({
        changed: ['src/a.ts'],
        version: '0.2.1',
        before,
        after: elsewhere,
      }),
    ).toContain('adds nothing under "## 0.2.1"')
    expect(
      changelogProblem({
        changed: ['guest-agent/Cargo.toml', 'package.json'],
        version: '0.2.2',
        before,
        after: '## 0.2.2\n\n' + before,
      }),
    ).toBeUndefined()
    expect(
      changelogProblem({
        changed: ['src/a.ts'],
        version: '0.2.1',
        before: undefined,
        after: undefined,
      }),
    ).toContain('adds nothing')
  })

  test('CI-only and docs-only changes need none', () => {
    expect(
      changelogProblem({
        changed: ['.github/workflows/ci.yml', 'docs/VM.md', 'README.md'],
        version: '0.2.1',
        before,
        after: before,
      }),
    ).toBeUndefined()
  })
})

describe("this repository's CHANGELOG.md", () => {
  test('the current version has a section with entries, and the npm package ships it', async () => {
    const text = await readFile(
      resolve(import.meta.dir, '../CHANGELOG.md'),
      'utf8',
    )
    expect(() => changelogSection(text, pkg.version)).not.toThrow()
    expect(pkg.files).toContain('CHANGELOG.md')
  })
})
