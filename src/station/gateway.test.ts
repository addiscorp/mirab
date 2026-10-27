import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { allowSecret } from 'rixse'
import { vmStation } from './gateway'

// A project's agent: its path can hold spaces.
const AGENT = 'project:/Users/x/my shop'

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
      expect(notes).toContain(
        'prod/shop/NOWHERE, which the vault lets go nowhere',
      )
      expect(notes).toContain("hosts the gateway can't open, left out: API.bad")
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
