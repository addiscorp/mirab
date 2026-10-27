// mirab's own commands for the gateway's grants: `mirab allow|revoke` (hosts
// an agent asked for) and `mirab secrets allow|list|revoke`, run in the
// person's terminal, writing what rixse's gateway reads.
import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { allowedFor, asker, projectAgent, secretGrants } from 'rixse'

function scratch() {
  mkdirSync(resolve('.tmp'), { recursive: true })
  return mkdtempSync(join(resolve('.tmp'), 'escalate-'))
}

const AGENT = 'gg.addis.agent.ops'

test('mirab allow works out whose ask it is, and says when it can’t', () => {
  const dir = scratch()
  const mirab = (...args: string[]) =>
    spawnSync('bun', [resolve('src/mirab.ts'), '--config-dir', dir, ...args], {
      encoding: 'utf8',
    })
  try {
    asker(dir, AGENT)('api.stripe.test')
    asker(dir, AGENT)('xn--pple-43d.test')
    const listed = JSON.parse(mirab('escalations').stdout)
    expect(listed.map((a: { host: string }) => a.host).sort()).toEqual([
      'api.stripe.test',
      'xn--pple-43d.test',
    ])
    expect(
      listed.find((a: { host: string }) => a.host.startsWith('xn--')).warning,
    ).toContain('punycode')
    const yes = mirab('allow', 'api.stripe.test.')
    expect(yes.status).toBe(0)
    expect(yes.stdout).toContain("add 'api.stripe.test' to domains")
    expect(allowedFor(dir, AGENT)).toEqual(['api.stripe.test'])
    asker(dir, 'a.b.agent.one')('x.example.test')
    asker(dir, 'a.b.agent.two')('x.example.test')
    const which = mirab('allow', 'x.example.test')
    expect(which.status).toBe(1)
    expect(which.stderr).toContain('--agent')
    expect(
      mirab('allow', 'x.example.test', '--agent', 'a.b.agent.two').status,
    ).toBe(0)
    expect(allowedFor(dir, 'a.b.agent.one')).toEqual([])
    expect(
      mirab('revoke', 'x.example.test', '--agent', 'a.b.agent.two').status,
    ).toBe(0)
    expect(allowedFor(dir, 'a.b.agent.two')).toEqual([])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('in a project folder, mirab secrets grants to the name mirab dev and spawn --vm look up', async () => {
  await mkdir(resolve('.tmp'), { recursive: true })
  const base = await mkdtemp(join(resolve('.tmp'), 'grant-cli-'))
  const project = join(base, 'project')
  await mkdir(project)
  try {
    const run = (...args: string[]) =>
      spawnSync(
        'bun',
        [resolve('src/mirab.ts'), '--config-dir', base, 'secrets', ...args],
        {
          cwd: project,
          encoding: 'utf8',
        },
      )
    expect(run('allow', 'prod/shop/STRIPE_KEY').status).toBe(0)
    expect(secretGrants(base, projectAgent(project))).toEqual([
      'prod/shop/STRIPE_KEY',
    ])
    expect(JSON.parse(run('list').stdout).secrets).toEqual([
      'prod/shop/STRIPE_KEY',
    ])
    expect(run('allow', '../x').status).toBe(2)
    expect(run('revoke', 'prod/shop/STRIPE_KEY').status).toBe(0)
    expect(secretGrants(base, projectAgent(project))).toEqual([])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
