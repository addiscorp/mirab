import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { allowSecret, revokeSecret, secretGrants } from './escalations'
import { vmStation } from './vm'

const AGENT = 'gg.addis.agent.ops'

test('a VM gets a placeholder only for a secret its agent was allowed and harar lets go somewhere; old station.json secrets are named as ignored', async () => {
  await mkdir(resolve('.tmp'), { recursive: true })
  const base = await mkdtemp(join(resolve('.tmp'), 'vmstation-'))
  const project = join(base, 'project')
  await mkdir(project)
  await writeFile(
    join(project, '.env'),
    [
      'STRIPE=harar://prod/shop/STRIPE_KEY',
      'NOWHERE=harar://prod/shop/NOWHERE',
      'UNASKED=harar://personal/bank/TOKEN',
      'BROKEN=harar://prod/shop/BROKEN',
    ].join('\n'),
  )
  const asked: string[] = []
  const socket = join(base, 'h.sock')
  const harar = createServer((conn) => {
    let body = ''
    conn.on('data', (c) => (body += c))
    conn.on('end', () => {
      const { op, key } = JSON.parse(body)
      asked.push(`${op} ${key}`)
      if (key === 'prod/shop/BROKEN') return conn.end('null')
      conn.end(
        JSON.stringify({
          ok: true,
          hosts:
            key === 'prod/shop/STRIPE_KEY' ? ['api.stripe.com', 'API.bad'] : [],
        }),
      )
    })
  })
  await new Promise<void>((r) => harar.listen(socket, r))
  try {
    for (const s of [
      'prod/shop/STRIPE_KEY',
      'prod/shop/NOWHERE',
      'prod/shop/BROKEN',
    ])
      allowSecret(base, AGENT, s)
    const station = await vmStation({
      project,
      station: {
        harar: { socket },
        models: {},
        secrets: { 'prod/shop/STRIPE_KEY': { hosts: ['x.example'] } },
      },
      configDir: base,
      zone: 'gg.addis.zone.vm-test',
      auditLog: join(base, 'egress.log'),
      routes: {},
      allow: [],
      agent: AGENT,
    })
    try {
      expect(
        Object.keys(station.env).filter((k) => !/proxy|CERTS/i.test(k)),
      ).toEqual(['STRIPE'])
      expect(station.env.STRIPE).toMatch(/^mirab-ph-[0-9a-f]{24}$/)
      const notes = station.notes.join('\n')
      expect(notes).toContain("station.json's secrets are ignored now")
      expect(notes).toContain(
        `mirab secrets allow personal/bank/TOKEN --agent '${AGENT}'`,
      )
      expect(notes).toContain('prod/shop/NOWHERE, which harar lets go nowhere')
      expect(notes).toContain("hosts the station can't open, left out: API.bad")
      expect(notes).toContain('BROKEN: harar at')
      // Never asked about the secret this agent wasn't allowed.
      expect(asked.sort()).toEqual([
        'hosts prod/shop/BROKEN',
        'hosts prod/shop/NOWHERE',
        'hosts prod/shop/STRIPE_KEY',
      ])
    } finally {
      await station.close()
    }
  } finally {
    harar.close()
    await rm(base, { recursive: true, force: true })
  }
})

test('secret grants are per agent, only harar paths, and revocable', async () => {
  await mkdir(resolve('.tmp'), { recursive: true })
  const dir = await mkdtemp(join(resolve('.tmp'), 'grants-'))
  try {
    allowSecret(dir, AGENT, 'prod/shop/STRIPE_KEY')
    allowSecret(dir, AGENT, 'prod/shop/STRIPE_KEY')
    expect(secretGrants(dir, AGENT)).toEqual(['prod/shop/STRIPE_KEY'])
    expect(secretGrants(dir, 'gg.addis.agent.other')).toEqual([])
    expect(() => allowSecret(dir, AGENT, '../etc/passwd')).toThrow('path')
    expect(() => allowSecret(dir, AGENT, 'a/../b')).toThrow('path')
    revokeSecret(dir, AGENT, 'prod/shop/STRIPE_KEY')
    expect(secretGrants(dir, AGENT)).toEqual([])
    expect(() => revokeSecret(dir, AGENT, 'prod/shop/STRIPE_KEY')).toThrow(
      "wasn't allowed",
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('in a project folder, mirab secrets grants to the name mirab dev and spawn --vm look up', async () => {
  const { spawnSync } = await import('node:child_process')
  const { projectAgent } = await import('./escalations')
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
