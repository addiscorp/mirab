import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { projectAgent } from 'rixse'
import {
  approvePending,
  approvedReach,
  pendingReach,
  withinApproval,
} from './approved'
import type { Manifest } from './manifest'

const manifest = (
  domains: string[],
  packages: string[],
  gateway: Manifest['gateway'] = {},
) =>
  ({
    name: 'gg.addis.agent.ops',
    model: 'anthropic/claude-sonnet-5-5',
    instructions: '',
    tools: {},
    domains,
    packages,
    channels: [],
    gateway,
  }) as unknown as Manifest

function scratch() {
  mkdirSync(resolve('.tmp'), { recursive: true })
  const configDir = mkdtempSync(join(resolve('.tmp'), 'approved-'))
  const project = join(configDir, 'project')
  mkdirSync(project)
  return { configDir, project }
}

test("whatever changed the agent's definition, what it newly asks to reach waits for the person", () => {
  const { configDir, project } = scratch()
  const logs: string[] = []
  const dev = { record: true, log: (l: string) => void logs.push(l) }
  try {
    // Looking first approves nothing: what it asks for is left out, and waits.
    const looked = withinApproval(
      configDir,
      project,
      manifest(['api.example.com'], ['jq']),
      { record: false },
    )
    expect(looked.domains).toEqual([])
    expect(approvedReach(configDir, project)).toBeUndefined()
    // The person starting it with mirab dev: approved, and said.
    expect(
      withinApproval(
        configDir,
        project,
        manifest(['api.example.com'], ['jq']),
        dev,
      ).domains,
    ).toEqual(['api.example.com'])
    expect(logs.join('\n')).toContain('first run here')
    expect(pendingReach(configDir, project)).toBeUndefined()
    // Later its code asks for more, by any route: left out, waiting, said.
    const wider = withinApproval(
      configDir,
      project,
      manifest(['api.example.com', 'evil.example.com'], ['jq', 'nmap']),
      dev,
    )
    expect(wider.domains).toEqual(['api.example.com'])
    expect(wider.packages).toEqual(['jq'])
    expect(logs.at(-1)).toContain('domains evil.example.com and packages nmap')
    // It stops asking: nothing waits, so an old ask can't be approved later.
    withinApproval(
      configDir,
      project,
      manifest(['api.example.com'], ['jq']),
      dev,
    )
    expect(pendingReach(configDir, project)).toBeUndefined()
    // Dropped, then added back: asks again.
    withinApproval(configDir, project, manifest([], ['jq']), dev)
    expect(
      withinApproval(
        configDir,
        project,
        manifest(['api.example.com'], ['jq']),
        dev,
      ).domains,
    ).toEqual([])
    // The person approves exactly what they were shown, or nothing.
    const shown = pendingReach(configDir, project)!
    withinApproval(
      configDir,
      project,
      manifest(['api.example.com', 'other.example.com'], ['jq']),
      dev,
    )
    expect(() => approvePending(configDir, project, shown)).toThrow(
      'changed since it was shown',
    )
    const now = pendingReach(configDir, project)!
    expect(approvePending(configDir, project, now)?.domains).toEqual([
      'api.example.com',
      'other.example.com',
    ])
    expect(
      withinApproval(
        configDir,
        project,
        manifest(['api.example.com', 'other.example.com'], ['jq']),
        dev,
      ).domains,
    ).toEqual(['api.example.com', 'other.example.com'])
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
})

test('a damaged approval is refused, never a first run; a project is its real folder', () => {
  const { configDir, project } = scratch()
  try {
    withinApproval(configDir, project, manifest(['api.example.com'], []), {
      record: true,
    })
    const link = join(configDir, 'link')
    symlinkSync(project, link)
    expect(projectAgent(link)).toBe(projectAgent(project))
    expect(approvedReach(configDir, link)?.domains).toEqual(['api.example.com'])
    const file = join(
      configDir,
      'manifests',
      `${encodeURIComponent(projectAgent(project))}.approved.json`,
    )
    for (const bad of ['{}', 'not json', '{"domains":"x","packages":[]}']) {
      writeFileSync(file, bad)
      expect(() =>
        withinApproval(configDir, project, manifest(['evil.example.com'], []), {
          record: true,
        }),
      ).toThrow("doesn't read as an approval")
    }
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
})

test('mirab manifest approve shows what it would approve, and without a terminal needs --yes', () => {
  const { configDir, project } = scratch()
  try {
    withinApproval(configDir, project, manifest([], []), { record: true })
    withinApproval(configDir, project, manifest(['api.example.com'], []), {
      record: true,
    })
    const run = (...args: string[]) =>
      spawnSync(
        'bun',
        [
          resolve('src/mirab.ts'),
          '--config-dir',
          configDir,
          'manifest',
          'approve',
          project,
          ...args,
        ],
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
      )
    const asked = run()
    expect(asked.status).toBe(2)
    expect(asked.stderr).toContain('asks for domains api.example.com')
    expect(approvedReach(configDir, project)?.domains).toEqual([])
    expect(run('--yes').status).toBe(0)
    expect(approvedReach(configDir, project)?.domains).toEqual([
      'api.example.com',
    ])
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
})

test('the gateway section in force is the one the person approved; any change waits, shown in full', () => {
  const { configDir, project } = scratch()
  const logs: string[] = []
  const dev = { record: true, log: (l: string) => void logs.push(l) }
  const push = {
    host: 'github.com',
    method: 'POST',
    path: '/acme/repo.git/git-receive-pack',
    effect: 'apply' as const,
  }
  const charges = {
    host: 'api.stripe.com',
    method: 'POST',
    effect: 'request' as const,
  }
  try {
    // The first run the person starts approves the section as it is.
    const first = withinApproval(
      configDir,
      project,
      manifest([], [], { rules: [charges] }),
      dev,
    )
    expect(first.gateway).toEqual({ rules: [charges] })
    // The same section, spelled in another order: nothing waits.
    withinApproval(
      configDir,
      project,
      manifest([], [], { rules: [charges, charges] }),
      dev,
    )
    expect(pendingReach(configDir, project)).toBeUndefined()
    // The agent's code adds a rule that lets it push: the approved section
    // stays in force, the new one waits, and the person sees every rule.
    const wider = withinApproval(
      configDir,
      project,
      manifest([], [], {
        rules: [charges, push],
        secrets: {
          'api.stripe.com': {
            agent: 'prod/shop/READ',
            approved: 'prod/shop/WRITE',
          },
        },
      }),
      dev,
    )
    expect(wider.gateway).toEqual({ rules: [charges] })
    expect(logs.at(-1)).toContain(
      'apply POST github.com/acme/repo.git/git-receive-pack',
    )
    expect(logs.at(-1)).toContain(
      'api.stripe.com uses prod/shop/READ (approved sends: prod/shop/WRITE)',
    )
    // Dropping every rule isn't taken as narrower: no rules is rixse's
    // defaults, which a person may not have chosen. It waits too.
    expect(
      withinApproval(configDir, project, manifest([], [], {}), dev).gateway,
    ).toEqual({ rules: [charges] })
    expect(pendingReach(configDir, project)?.gateway).toEqual({})
    // Approved as shown: now it's in force.
    const asked = {
      rules: [charges, push],
      secrets: { 'api.stripe.com': { agent: 'prod/shop/READ' } },
    }
    withinApproval(configDir, project, manifest([], [], asked), dev)
    approvePending(configDir, project, pendingReach(configDir, project)!)
    expect(
      withinApproval(configDir, project, manifest([], [], asked), dev).gateway,
    ).toEqual({
      rules: [charges, push],
      secrets: { 'api.stripe.com': { agent: 'prod/shop/READ' } },
    })
    expect(pendingReach(configDir, project)).toBeUndefined()
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
})

test('an approval from before gateway sections approves none; a damaged section is refused', () => {
  const { configDir, project } = scratch()
  try {
    withinApproval(configDir, project, manifest(['api.example.com'], []), {
      record: true,
    })
    const file = join(
      configDir,
      'manifests',
      `${encodeURIComponent(projectAgent(project))}.approved.json`,
    )
    writeFileSync(
      file,
      JSON.stringify({ domains: ['api.example.com'], packages: [] }),
    )
    const rules = [{ host: 'github.com', effect: 'apply' as const }]
    expect(
      withinApproval(
        configDir,
        project,
        manifest(['api.example.com'], [], { rules }),
        {
          record: true,
        },
      ).gateway,
    ).toEqual({})
    writeFileSync(
      file,
      JSON.stringify({
        domains: [],
        packages: [],
        gateway: { rules: [{ host: 'x' }] },
      }),
    )
    expect(() =>
      withinApproval(configDir, project, manifest([], []), { record: true }),
    ).toThrow("doesn't read as an approval")
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
})

test('a gateway section rixse would refuse is never recorded nor waits; the approved one stays', () => {
  const { configDir, project } = scratch()
  const logs: string[] = []
  const dev = { record: true, log: (l: string) => void logs.push(l) }
  const bad = {
    rules: [{ host: 'github.com', path: '/a;b', effect: 'apply' as const }],
  }
  const good = { rules: [{ host: 'github.com', effect: 'request' as const }] }
  try {
    // A first run with a bad section approves none.
    expect(
      withinApproval(configDir, project, manifest([], [], bad), dev).gateway,
    ).toEqual({})
    expect(approvedReach(configDir, project)?.gateway).toEqual({})
    expect(logs.join('\n')).toContain(
      "gateway section can't be used (path /a;b",
    )
    // A good one, approved; then the agent's code breaks it: the good one stays, nothing waits.
    withinApproval(configDir, project, manifest([], [], good), dev)
    approvePending(configDir, project, pendingReach(configDir, project)!)
    expect(
      withinApproval(configDir, project, manifest([], [], bad), dev).gateway,
    ).toEqual(good)
    expect(pendingReach(configDir, project)).toBeUndefined()
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
})
