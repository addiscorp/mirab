// What a person approved a project's agent to reach: its manifest's domains
// (the station's whitelist) and packages (its image). The manifest is read
// from the agent's own code in its VM, and that code can change: in the VM,
// through a file it imports from outside agent/, through package.json. So
// whatever the manifest asks for now is checked against what the person
// approved; anything new waits (`mirab manifest approve`), never quietly in
// effect. Tools need no approval: they run in the VM, and what they can reach
// is still the whitelist and the station.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileName, projectAgent, writeJson } from '../station/escalations'
import type { Manifest } from './manifest'

export interface Reach {
  domains: string[]
  packages: string[]
}

const reachPath = (configDir: string, project: string, kind: string) =>
  join(
    configDir,
    'manifests',
    `${fileName(projectAgent(project))}.${kind}.json`,
  )

const reachOf = (m: Pick<Manifest, 'domains' | 'packages'>): Reach => ({
  domains: [...new Set(m.domains)].sort(),
  packages: [...new Set(m.packages)].sort(),
})

/** A reach file: missing (nothing yet), or what it holds; a file that is
 *  there but doesn't read as one is an error, never "nothing yet", so a
 *  damaged or tampered file can't turn into a first run that approves all. */
function read(path: string): Reach | undefined {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw e
  }
  let r: unknown
  try {
    r = JSON.parse(text)
  } catch {
    r = undefined
  }
  if (r === null) return undefined
  const ok = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((x) => typeof x === 'string')
  const reach = r as Partial<Reach> | undefined
  if (!reach || !ok(reach.domains) || !ok(reach.packages))
    throw new Error(`${path} doesn't read as an approval; fix or remove it`)
  return { domains: reach.domains, packages: reach.packages }
}

/** What the person approved for `project`'s agent, if anything yet. */
export const approvedReach = (configDir: string, project: string) =>
  read(reachPath(configDir, project, 'approved'))

/** What the agent last asked for beyond its approval, waiting. */
export const pendingReach = (configDir: string, project: string) =>
  read(reachPath(configDir, project, 'pending'))

/** What `asked` adds to `approved`. */
export const beyond = (approved: Reach, asked: Reach): Reach => ({
  domains: asked.domains.filter((d) => !approved.domains.includes(d)),
  packages: asked.packages.filter((p) => !approved.packages.includes(p)),
})

const isEmpty = (r: Reach) => !r.domains.length && !r.packages.length

/**
 * The manifest as it may run: its domains and packages narrowed to what the
 * person approved. Only a session the person starts (`record`, mirab dev)
 * records a first approval, and says what it was; anything else (looking at
 * the manifest, building its image) approves nothing. After that, anything
 * new is left out, kept as pending, and said; what the agent no longer asks
 * for is no longer approved, so dropping something and adding it back asks
 * again.
 */
export function withinApproval(
  configDir: string,
  project: string,
  manifest: Manifest,
  o: { record: boolean; log?: (line: string) => void },
): Manifest {
  const asked = reachOf(manifest)
  const approvedPath = reachPath(configDir, project, 'approved')
  const pendingPath = reachPath(configDir, project, 'pending')
  let approved = approvedReach(configDir, project)
  if (!approved) {
    if (!o.record) {
      approved = { domains: [], packages: [] }
    } else {
      writeJson(approvedPath, asked)
      writeJson(pendingPath, null)
      if (!isEmpty(asked))
        o.log?.(
          `first run here: approved ${describe(asked)} (later changes wait for mirab manifest approve)`,
        )
      return manifest
    }
  } else {
    // What it stopped asking for stops being approved.
    const kept: Reach = {
      domains: approved.domains.filter((d) => asked.domains.includes(d)),
      packages: approved.packages.filter((p) => asked.packages.includes(p)),
    }
    if (
      kept.domains.length !== approved.domains.length ||
      kept.packages.length !== approved.packages.length
    ) {
      writeJson(approvedPath, kept)
      approved = kept
    }
  }
  const extra = beyond(approved, asked)
  if (isEmpty(extra)) {
    // Nothing waits any more: an old ask can't be approved later by mistake.
    writeJson(pendingPath, null)
  } else {
    writeJson(pendingPath, asked)
    o.log?.(
      `the agent's definition asks for ${describe(extra)}, which you haven't approved: left out. If that was you, run mirab manifest approve here (never in the VM)`,
    )
  }
  return {
    ...manifest,
    domains: manifest.domains.filter((d) => approved.domains.includes(d)),
    packages: manifest.packages.filter((p) => approved.packages.includes(p)),
  }
}

/** The person's yes to what waits, exactly as they were shown it: `shown`
 *  must equal what is pending now, or nothing is approved. */
export function approvePending(
  configDir: string,
  project: string,
  shown: Reach,
): Reach | undefined {
  const pending = pendingReach(configDir, project)
  if (!pending) return undefined
  if (JSON.stringify(pending) !== JSON.stringify(shown))
    throw new Error('what waits changed since it was shown; look again')
  writeJson(reachPath(configDir, project, 'approved'), pending)
  writeJson(reachPath(configDir, project, 'pending'), null)
  return pending
}

export function describe(r: Reach) {
  const parts = [
    r.domains.length && `domains ${r.domains.join(', ')}`,
    r.packages.length && `packages ${r.packages.join(', ')}`,
  ].filter(Boolean)
  return parts.join(' and ')
}
