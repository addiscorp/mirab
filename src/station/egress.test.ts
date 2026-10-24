import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { connect, createServer, type Socket } from 'node:net'
import { join, resolve } from 'node:path'
import * as tls from 'node:tls'
import { mkdirSync } from 'node:fs'
import { allowed, startEgress } from './egress'

function scratch() {
  mkdirSync(resolve('.tmp'), { recursive: true })
  return mkdtempSync(join(resolve('.tmp'), 'egress-'))
}

/** A stand-in for the internet: records what reaches it, per host it was dialed as. */
function upstream() {
  const dialed: string[] = []
  const received: Buffer[] = []
  const server = createServer((s) => s.on('data', (c) => received.push(c)))
  server.listen(0, '127.0.0.1')
  const dial = (host: string, port: number): Socket => {
    dialed.push(`${host}:${port}`)
    return connect({
      host: '127.0.0.1',
      port: (server.address() as { port: number }).port,
    })
  }
  return {
    server,
    dialed,
    received,
    dial,
    bytes: () => Buffer.concat(received),
  }
}

/** Opens the VM's side of the station socket and sends `head`. */
async function open(socketPath: string, head: string) {
  const s = connect(socketPath)
  await new Promise<void>((r) => s.once('connect', () => r()))
  s.write(head)
  return s
}

function firstReply(s: Socket): Promise<string> {
  return new Promise((r) => s.once('data', (c) => r(c.toString('latin1'))))
}

async function station(
  dir: string,
  extra: Partial<Parameters<typeof startEgress>[0]> = {},
) {
  const up = upstream()
  const socketPath = join(dir, 'vm.sock_9101')
  const server = await startEgress({
    socketPath,
    zone: 'gg.addis.zone.vm-test',
    allow: ['registry.example.test', '*.github.example'],
    routes: {},
    auditLog: join(dir, 'egress.log'),
    dial: up.dial,
    ...extra,
  })
  return {
    up,
    socketPath,
    server,
    audit: () => readFileSync(join(dir, 'egress.log'), 'utf8'),
  }
}

test('the whitelist: exact names and *. suffixes, nothing else', () => {
  const allow = ['registry.example.test', '*.github.example']
  expect(allowed('registry.example.test', allow)).toBe(true)
  expect(allowed('REGISTRY.example.test.', allow)).toBe(true)
  expect(allowed('api.github.example', allow)).toBe(true)
  for (const no of [
    'github.example',
    'evilgithub.example',
    'registry.example.test.evil',
    'example.test',
    'x.registry.example.test',
  ])
    expect(allowed(no, allow), no).toBe(false)
})

test('a whitelisted domain is tunnelled, TLS untouched, once its server name matches', async () => {
  const dir = scratch()
  const s = await station(dir)
  try {
    const vm = await open(
      s.socketPath,
      'CONNECT registry.example.test:443 HTTP/1.1\r\nHost: registry.example.test:443\r\n\r\n',
    )
    expect(await firstReply(vm)).toStartWith('HTTP/1.1 200')
    // The VM's TLS client says hello; the station checks the name, then passes it on as is.
    const client = tls.connect({
      socket: vm,
      servername: 'registry.example.test',
      rejectUnauthorized: false,
    })
    client.on('error', () => {})
    await new Promise((r) => setTimeout(r, 300))
    expect(s.up.dialed).toEqual(['registry.example.test:443'])
    const hello = s.up.bytes()
    expect(hello[0]).toBe(0x16) // a TLS handshake record, not something the station made up
    expect(hello.includes(Buffer.from('registry.example.test'))).toBe(true)
    // When the VM's side goes, the tunnel ends and is logged: it never outlives its use.
    client.destroy()
    vm.destroy()
    let audit = ''
    for (let i = 0; i < 20 && !audit.includes('closed by the VM'); i++) {
      await new Promise((r) => setTimeout(r, 50))
      audit = s.audit()
    }
    expect(audit).toContain('closed by the VM')
  } finally {
    s.server.close()
    s.up.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a TLS server name other than the allowed host is cut off before anything is dialed', async () => {
  const dir = scratch()
  const s = await station(dir)
  try {
    const vm = await open(
      s.socketPath,
      'CONNECT registry.example.test:443 HTTP/1.1\r\n\r\n',
    )
    expect(await firstReply(vm)).toStartWith('HTTP/1.1 200')
    const client = tls.connect({
      socket: vm,
      servername: 'exfil.example',
      rejectUnauthorized: false,
    })
    client.on('error', () => {})
    await new Promise((r) => setTimeout(r, 300))
    expect(s.up.dialed).toEqual([])
    expect(s.audit()).toContain("TLS server name exfil.example isn't the host")
  } finally {
    s.server.close()
    s.up.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('domains off the list, other ports and plain HTTP are refused, and nothing is dialed', async () => {
  const dir = scratch()
  const s = await station(dir)
  try {
    for (const [head, want] of [
      ['CONNECT other.example:443 HTTP/1.1\r\n\r\n', 'not on the whitelist'],
      ['CONNECT registry.example.test:22 HTTP/1.1\r\n\r\n', 'only port 443'],
      ['GET http://registry.example.test/ HTTP/1.1\r\n\r\n', 'plain HTTP'],
      [
        'POST /nowhere/x HTTP/1.1\r\ncontent-length: 0\r\n\r\n',
        'no such route',
      ],
    ]) {
      const vm = await open(s.socketPath, head)
      expect(await firstReply(vm), head).toContain(want)
      vm.destroy()
    }
    expect(s.up.dialed).toEqual([])
    expect(s.audit().trim().split('\n')).toHaveLength(4)
  } finally {
    s.server.close()
    s.up.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the model route swaps the placeholder for the real key, and the key is never logged', async () => {
  const dir = scratch()
  const seen: { key: string | null; auth: string | null; body: string }[] = []
  const api = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      seen.push({
        key: request.headers.get('x-api-key'),
        auth: request.headers.get('authorization'),
        body: await request.text(),
      })
      return Response.json({ ok: true, path: new URL(request.url).pathname })
    },
  })
  let fetched = 0
  const s = await station(dir, {
    routes: {
      anthropic: {
        upstream: api.url.origin,
        header: 'x-api-key',
        credential: async () => {
          fetched++
          return 'sk-real-secret'
        },
      },
    },
  })
  try {
    for (let i = 0; i < 2; i++) {
      const body = '{"model":"claude-sonnet-5-5"}'
      const vm = await open(
        s.socketPath,
        `POST /anthropic/v1/messages HTTP/1.1\r\nx-api-key: mirab-placeholder\r\nauthorization: Bearer stolen\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\n\r\n${body}`,
      )
      const reply = await new Promise<string>((r) => {
        let all = ''
        vm.on('data', (c) => (all += c.toString()))
        vm.on('close', () => r(all))
      })
      expect(reply).toStartWith('HTTP/1.1 200')
      expect(reply).toContain('"path":"/v1/messages"')
    }
    expect(seen.map((r) => r.key)).toEqual(['sk-real-secret', 'sk-real-secret'])
    expect(seen.map((r) => r.auth)).toEqual([null, null]) // what the VM sent is dropped
    expect(seen[0].body).toBe('{"model":"claude-sonnet-5-5"}')
    expect(fetched).toBe(1) // fetched from harar once, then kept in the station
    expect(s.audit()).not.toContain('sk-real-secret')
    expect(s.audit()).not.toContain('placeholder')
    expect(s.audit()).toContain('"route":"anthropic"')
  } finally {
    s.server.close()
    s.up.server.close()
    api.stop(true)
    rmSync(dir, { recursive: true, force: true })
  }
})
