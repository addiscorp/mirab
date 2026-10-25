import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { startEgress } from './egress'
import {
  allow,
  allowedFor,
  asker,
  asks,
  dismiss,
  grants,
  revoke,
} from './escalations'

function scratch() {
  mkdirSync(resolve('.tmp'), { recursive: true })
  return mkdtempSync(join(resolve('.tmp'), 'escalate-'))
}

const AGENT = 'gg.addis.agent.ops'

async function station(dir: string) {
  const upstream = createServer(() => {})
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
  const socketPath = join(dir, 'vm.sock_9101')
  const server = await startEgress({
    socketPath,
    zone: 'gg.addis.zone.vm-test',
    allow: ['registry.example.test'],
    routes: {},
    auditLog: join(dir, 'egress.log'),
    dial: () =>
      connect({
        host: '127.0.0.1',
        port: (upstream.address() as { port: number }).port,
      }),
    resolve: async () => ['104.16.24.34'],
    granted: grants(dir, AGENT),
    asked: asker(dir, AGENT),
  })
  return { socketPath, close: () => (server.close(), upstream.close()) }
}

/** The station's answer to a VM's CONNECT. */
async function connectTo(socketPath: string, host: string) {
  const s = connect(socketPath)
  await new Promise<void>((r) => s.once('connect', () => r()))
  s.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`)
  const reply = await new Promise<string>((r) =>
    s.once('data', (c) => r(c.toString('latin1'))),
  )
  s.destroy()
  return reply.split('\r\n')[0]
}

test('a refused host is asked for, and a yes outside the VM lets the next connection through', async () => {
  const dir = scratch()
  const { socketPath, close } = await station(dir)
  try {
    expect(await connectTo(socketPath, 'api.stripe.test')).toStartWith(
      'HTTP/1.1 403',
    )
    expect(asks(dir).map((a) => [a.agent, a.host, a.count])).toEqual([
      [AGENT, 'api.stripe.test', 1],
    ])
    // The person's answer: no restart, the running station reads it.
    allow(dir, AGENT, 'api.stripe.test')
    expect(await connectTo(socketPath, 'api.stripe.test')).toBe(
      'HTTP/1.1 200 Connection established',
    )
    expect(asks(dir)).toEqual([])
    // Another host is still refused; a yes taken back is refused again.
    expect(await connectTo(socketPath, 'evil.example.test')).toStartWith(
      'HTTP/1.1 403',
    )
    revoke(dir, AGENT, 'api.stripe.test')
    expect(await connectTo(socketPath, 'api.stripe.test')).toStartWith(
      'HTTP/1.1 403',
    )
  } finally {
    close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a VM flooding the station with names is recorded sparingly, and buries no one', () => {
  const dir = scratch()
  try {
    asker(dir, 'a.b.agent.quiet')('api.github.com')
    const ask = asker(dir, AGENT)
    const now = new Date('2026-10-24T12:00:00Z')
    ask('api.github.com', now)
    ask('API.GITHUB.COM.', now)
    for (const bad of ['127.0.0.1', 'localhost', 'com', 'a..b']) ask(bad, now)
    for (let n = 0; n < 500; n++) ask(`h${n}.example.test`, now)
    const mine = asks(dir).filter((a) => a.agent === AGENT)
    // Once per host, at most ten new hosts a minute; never an address or a bare name.
    expect(mine.length).toBe(10)
    expect(mine.filter((a) => a.host === 'api.github.com').length).toBe(1)
    // The other agent's ask is still there.
    expect(
      asks(dir).some(
        (a) => a.agent === 'a.b.agent.quiet' && a.host === 'api.github.com',
      ),
    ).toBe(true)
    // A minute later the agent may ask again, a little.
    ask('later.example.test', new Date('2026-10-24T12:01:00Z'))
    expect(asks(dir).some((a) => a.host === 'later.example.test')).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a dismissed host shows again only when asked for again, and grants are read when they change', () => {
  const dir = scratch()
  try {
    asker(dir, AGENT)('x.example.test', new Date('2026-10-24T12:00:00Z'))
    dismiss(dir, AGENT, 'x.example.test', new Date('2026-10-24T12:05:00Z'))
    expect(asks(dir)).toEqual([])
    asker(dir, AGENT)('x.example.test', new Date('2026-10-24T12:10:00Z'))
    expect(asks(dir).map((a) => a.host)).toEqual(['x.example.test'])
    const granted = grants(dir, AGENT)
    expect(granted()).toEqual([])
    allow(dir, AGENT, 'x.example.test.')
    expect(granted()).toEqual(['x.example.test'])
    expect(() => allow(dir, AGENT, '10.0.0.1')).toThrow('address')
    // An agent name too long for a file name still has its own files.
    const long = `project:/${'deep/'.repeat(60)}repo`
    asker(dir, long)('y.example.test')
    allow(dir, long, 'y.example.test')
    expect(allowedFor(dir, long)).toEqual(['y.example.test'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

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
