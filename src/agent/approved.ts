// What a person approved a project's agent to reach: its manifest's domains
// (the station's whitelist) and packages (its image). The manifest is read
// from the agent's own code in its VM, and that code can change: in the VM,
// through a file it imports from outside agent/, through package.json. So
// whatever the manifest asks for now is checked against what the person
// approved; anything new waits (`mirab manifest approve`), never quietly in
// effect. Tools need no approval: they run in the VM, and what they can reach
// is still the whitelist and the station.
import { join } from 'node:path'
import {
  fileName,
  projectAgent,
  readJson,
  writeJson,
} from '../station/escalations'
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

function read(path: string): Reach | undefined {
  const r = readJson<Partial<Reach> | undefined>(path, undefined)
  if (!r || !Array.isArray(r.domains) || !Array.isArray(r.packages))
    return undefined
  return {
    domains: r.domains.filter((d): d is string => typeof d === 'string'),
    packages: r.packages.filter((p): p is string => typeof p === 'string'),
  }
}

/** What the person approved for `project`'s agent, if anything yet. */
export const approvedReach = (configDir: string, project: string) =>
  read(reachPath(configDir, project, 'approved'))

/** What the agent asked for last time beyond its approval, waiting. */
export const pendingReach = (configDir: string, project: string) =>
  read(reachPath(configDir, project, 'pending'))

/**
 * The manifest as it may run: its domains and packages narrowed to what the
 * person approved. The first time (nothing approved yet) is the person
 * starting this agent: what it asks for is approved, and said. Anything new
 * after that is left out, kept as pending, and said.
 */
export function withinApproval(
  configDir: string,
  project: string,
  manifest: Manifest,
  log?: (line: string) => void,
): Manifest {
  const asked = reachOf(manifest)
  const approved = approvedReach(configDir, project)
  if (!approved) {
    writeJson(reachPath(configDir, project, 'approved'), asked)
    if (asked.domains.length || asked.packages.length)
      log?.(
        `first run here: approved ${describe(asked)} (mirab manifest approve records later changes)`,
      )
    return manifest
  }
  const extra: Reach = {
    domains: asked.domains.filter((d) => !approved.domains.includes(d)),
    packages: asked.packages.filter((p) => !approved.packages.includes(p)),
  }
  if (extra.domains.length || extra.packages.length) {
    writeJson(reachPath(configDir, project, 'pending'), asked)
    log?.(
      `the agent's definition now asks for ${describe(extra)}, which you haven't approved: left out of this session. If that was you, run mirab manifest approve here (never in the VM)`,
    )
  }
  return {
    ...manifest,
    domains: manifest.domains.filter((d) => approved.domains.includes(d)),
    packages: manifest.packages.filter((p) => approved.packages.includes(p)),
  }
}

/** The person's yes to what is pending: it becomes what is approved. */
export function approvePending(
  configDir: string,
  project: string,
): Reach | undefined {
  const pending = pendingReach(configDir, project)
  if (!pending) return undefined
  writeJson(reachPath(configDir, project, 'approved'), pending)
  writeJson(reachPath(configDir, project, 'pending'), null)
  return pending
}

function describe(r: Reach) {
  const parts = [
    r.domains.length && `domains ${r.domains.join(', ')}`,
    r.packages.length && `packages ${r.packages.join(', ')}`,
  ].filter(Boolean)
  return parts.join(' and ')
}
