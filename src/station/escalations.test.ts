import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { startEgress } from './egress'
import { allow, allowedFor, asks, dismiss, recordAsk } from './escalations'

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
    granted: () => allowedFor(dir, AGENT),
    asked: (host) => recordAsk(dir, AGENT, host),
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
    // Another host is still refused.
    expect(await connectTo(socketPath, 'evil.example.test')).toStartWith(
      'HTTP/1.1 403',
    )
  } finally {
    close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('asks are counted once per agent and host, never for an address or a bare name, and capped', () => {
  const dir = scratch()
  try {
    recordAsk(dir, AGENT, 'api.github.com')
    recordAsk(dir, AGENT, 'API.GITHUB.COM.')
    for (const bad of ['127.0.0.1', 'localhost', 'com', 'a..b'] as const)
      recordAsk(dir, AGENT, bad)
    expect(asks(dir).map((a) => [a.host, a.count])).toEqual([
      ['api.github.com', 2],
    ])
    for (let n = 0; n < 150; n++)
      recordAsk(dir, 'other.agent', `h${n}.example.test`)
    expect(asks(dir).length).toBe(100)
    dismiss(dir, AGENT, 'api.github.com')
    expect(asks(dir).some((a) => a.agent === AGENT)).toBe(false)
    expect(() => allow(dir, AGENT, '10.0.0.1')).toThrow('address')
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
    recordAsk(dir, AGENT, 'api.stripe.test')
    expect(JSON.parse(mirab('escalations').stdout)[0].host).toBe(
      'api.stripe.test',
    )
    const yes = mirab('allow', 'api.stripe.test')
    expect(yes.status).toBe(0)
    expect(yes.stdout).toContain("add 'api.stripe.test' to domains")
    expect(allowedFor(dir, AGENT)).toEqual(['api.stripe.test'])
    recordAsk(dir, 'a.b.agent.one', 'x.example.test')
    recordAsk(dir, 'a.b.agent.two', 'x.example.test')
    const which = mirab('allow', 'x.example.test')
    expect(which.status).toBe(1)
    expect(which.stderr).toContain('--agent')
    expect(
      mirab('allow', 'x.example.test', '--agent', 'a.b.agent.two').status,
    ).toBe(0)
    expect(allowedFor(dir, 'a.b.agent.one')).toEqual([])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
