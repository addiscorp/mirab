// CHANGELOG.md, read by the release workflows and CI (one parser for all):
//
//   bun scripts/changelog.ts section <X.Y.Z> [file]
//       the body of `## X.Y.Z`; exits 1 when it is missing or empty
//   bun scripts/changelog.ts notes <X.Y.Z> [file]
//       a stable release's GitHub body (promote.yml): the section, then the
//       install line; exits 1 when the section is missing or empty
//   bun scripts/changelog.ts notes <X.Y.Z> [file] --canary <tag> <commit>
//       a canary's body (release.yml): the section as it stands at that
//       commit, marked as a canary; a missing or empty one is said, not fatal
//   bun scripts/changelog.ts check <base ref>
//       CI (changelog.yml): a change to what mirab ships must change the
//       current version's section; the `no-changelog` label skips the job
//
// One `## X.Y.Z` section per base version (no "v"; text may follow the
// version, as in `## 0.2.1 (unreleased)`). It ends at the next `## ` heading.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
export const INSTALL = 'https://mirab-releases.addis.gg/install.sh'

/** What mirab ships: a change under any of these needs a CHANGELOG entry. */
export const SHIPPED = [
  'src/',
  'guest-agent/',
  'scripts/',
  'vz/',
  'install.sh',
  'types/',
]

export class ChangelogError extends Error {}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The text under `## <version>` up to the next `## ` heading, or undefined. */
export function findSection(text: string, version: string): string | undefined {
  const lines = text.split('\n')
  const heading = new RegExp(`^## v?${escape(version)}(\\s.*)?$`)
  const start = lines.findIndex((l) => heading.test(l.trimEnd()))
  if (start < 0) return undefined
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l))
  if (end < 0) end = lines.length
  return lines
    .slice(start + 1, end)
    .join('\n')
    .trim()
}

/** A line that says something: not blank, a heading, a comment or "None". */
const says = (line: string) => {
  const l = line.trim()
  return (
    l !== '' &&
    !/^#{1,6}\s/.test(l) &&
    !/^<!--.*-->$/.test(l) &&
    !/^[-*]?\s*_?none\.?_?$/i.test(l)
  )
}

/** The section's body; refuses a missing or empty one, naming which. */
export function changelogSection(text: string, version: string): string {
  const body = findSection(text, version)
  if (body === undefined)
    throw new ChangelogError(`CHANGELOG.md has no "## ${version}" section`)
  if (!body.split('\n').some(says))
    throw new ChangelogError(
      `CHANGELOG.md's "## ${version}" section is empty: list its changes before releasing it`,
    )
  return body
}

/** A GitHub release body. Stable: the section (required) and the install
 *  line. Canary: the section so far, marked as a canary. */
export function releaseNotes(
  text: string,
  version: string,
  canary?: { tag: string; commit: string },
): string {
  if (!canary)
    return `${changelogSection(text, version)}\n\n---\n\nInstall: \`curl -fsSL ${INSTALL} | sh\`\n`
  let body: string
  try {
    body = changelogSection(text, version)
  } catch (e) {
    if (!(e instanceof ChangelogError)) throw e
    body = `_No CHANGELOG.md entries for ${version} yet._`
  }
  return [
    `**Canary** ${canary.tag}, built from ${canary.commit}. Not a stable release: these are the ${version} changes so far, from CHANGELOG.md at this commit.`,
    '',
    body,
    '',
    '---',
    '',
    `Install: \`curl -fsSL ${INSTALL} | sh -s -- --canary\``,
    '',
  ].join('\n')
}

/** CI's rule: why this change needs a CHANGELOG entry it lacks, or undefined. */
export function changelogProblem(o: {
  changed: string[]
  version: string
  before: string | undefined
  after: string | undefined
}): string | undefined {
  const shipped = o.changed.filter((f) =>
    SHIPPED.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p)),
  )
  if (!shipped.length) return undefined
  const was =
    o.before === undefined ? undefined : findSection(o.before, o.version)
  const now =
    o.after === undefined ? undefined : findSection(o.after, o.version)
  if (now !== undefined && now !== was) return undefined
  return (
    `this change touches what mirab ships (${shipped.slice(0, 5).join(', ')}${shipped.length > 5 ? ', …' : ''}) ` +
    `but adds nothing under "## ${o.version}" in CHANGELOG.md. ` +
    `Add an entry (Breaking / Changed / Added / Fixed / Upgrade notes), ` +
    `or label the PR no-changelog if it changes nothing a consumer sees`
  )
}

function git(args: string[]): string | undefined {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' })
  return r.status === 0 ? r.stdout : undefined
}

if (import.meta.main) {
  const [command, a, ...rest] = process.argv.slice(2)
  const read = (file?: string) =>
    readFileSync(resolve(file ?? join(ROOT, 'CHANGELOG.md')), 'utf8')
  try {
    if (command === 'section' && a)
      console.log(changelogSection(read(rest[0]), a))
    else if (command === 'notes' && a) {
      const i = rest.indexOf('--canary')
      const file = i === 0 ? undefined : rest[0]
      const canary =
        i >= 0 && rest[i + 1] && rest[i + 2]
          ? { tag: rest[i + 1]!, commit: rest[i + 2]! }
          : undefined
      if (i >= 0 && !canary)
        throw new ChangelogError('--canary needs <tag> <commit>')
      process.stdout.write(releaseNotes(read(file), a, canary))
    } else if (command === 'check' && a) {
      const changed = git(['diff', '--name-only', `${a}...HEAD`])
      if (changed === undefined)
        throw new ChangelogError(`cannot diff against ${a}`)
      const version = JSON.parse(read(join(ROOT, 'package.json'))).version
      const base = git(['merge-base', a, 'HEAD'])?.trim()
      const problem = changelogProblem({
        changed: changed.split('\n').filter(Boolean),
        version,
        before: base ? git(['show', `${base}:CHANGELOG.md`]) : undefined,
        after: git(['show', 'HEAD:CHANGELOG.md']),
      })
      if (problem) throw new ChangelogError(problem)
      console.log(`CHANGELOG.md: ok for ${version}`)
    } else
      throw new ChangelogError(
        'usage: changelog.ts section <X.Y.Z> [file] | notes <X.Y.Z> [file] [--canary <tag> <commit>] | check <base ref>',
      )
  } catch (e) {
    console.error(`changelog: ${(e as Error).message}`)
    process.exit(1)
  }
}
