import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { connect, createServer, type Socket } from 'node:net'
import { join, resolve } from 'node:path'
import * as tls from 'node:tls'
import { mkdirSync } from 'node:fs'
import { allowed, isPublic, serverName, startEgress } from './egress'

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
    // A public address; the fake dial never really reaches it.
    resolve: async () => ['104.16.24.34'],
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
    expect(s.up.dialed).toEqual(['104.16.24.34:443']) // the address the station checked
    const hello = s.up.bytes()
    expect(hello[0]).toBe(0x16) // a TLS handshake record, not something the station made up
    expect(hello.includes(Buffer.from('registry.example.test'))).toBe(true)
    // When the VM's side goes, the tunnel ends and is logged: it never outlives its use.
    client.destroy()
    vm.destroy()
    let audit = ''
    for (let i = 0; i < 20 && !audit.includes('"up":'); i++) {
      await new Promise((r) => setTimeout(r, 50))
      audit = s.audit()
    }
    expect(audit).toMatch(
      /"host":"registry.example.test","result":"(closed[^"]*|VM side error)","up":\d+/,
    )
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

test('public addresses only: never the host, the LAN, link-local, CGNAT or IPv6 equivalents', () => {
  for (const ok of ['104.16.24.34', '8.8.8.8', '2606:4700::6810:1822'])
    expect(isPublic(ok), ok).toBe(true)
  for (const no of [
    '127.0.0.1',
    '10.1.2.3',
    '192.168.1.10',
    '172.20.0.1',
    '169.254.169.254',
    '100.101.102.103',
    '0.0.0.0',
    '203.0.113.7',
    '198.51.100.1',
    '192.0.2.1',
    '255.255.255.255',
    '::1',
    '::',
    '::127.0.0.1',
    '::7f00:1',
    '::ffff:127.0.0.1',
    '0:0:0:0:0:ffff:127.0.0.1',
    '::FFFF:7F00:1',
    '0064:ff9b::7f00:1',
    '64:ff9b:1::1',
    '2002:7f00:1::',
    '2001::1',
    '2001:db8::1',
    '100::1',
    'fd00::1',
    'fe80::1',
    'fec0::1',
    'ff02::1',
    'not-an-ip',
    'fe80::1%en0',
    '::ffff:0:10.0.0.1',
    '3fff::1',
  ])
    expect(isPublic(no), no).toBe(false)
})

test('a whitelisted name that resolves to a private address is never dialed', async () => {
  const dir = scratch()
  const s = await station(dir, { resolve: async () => ['127.0.0.1'] })
  try {
    const vm = await open(
      s.socketPath,
      'CONNECT registry.example.test:443 HTTP/1.1\r\n\r\n',
    )
    expect(await firstReply(vm)).toStartWith('HTTP/1.1 200')
    const client = tls.connect({
      socket: vm,
      servername: 'registry.example.test',
      rejectUnauthorized: false,
    })
    client.on('error', () => {})
    await new Promise((r) => setTimeout(r, 300))
    expect(s.up.dialed).toEqual([])
    expect(s.audit()).toContain('not public')
  } finally {
    s.server.close()
    s.up.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a route sends the key only to its own host, whatever the path, and takes large bodies', async () => {
  const dir = scratch()
  const seen: { host: string; length: number }[] = []
  const api = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      seen.push({
        host: new URL(request.url).host,
        length: (await request.arrayBuffer()).byteLength,
      })
      return Response.json({ ok: true })
    },
  })
  const s = await station(dir, {
    routes: {
      anthropic: {
        upstream: api.url.origin,
        header: 'x-api-key',
        credential: async () => 'sk-real-secret',
      },
    },
  })
  const ask = async (head: string) => {
    const vm = await open(s.socketPath, head)
    return new Promise<string>((r) => {
      let all = ''
      vm.on('data', (c) => (all += c.toString()))
      vm.on('close', () => r(all))
    })
  }
  try {
    for (const path of ['//evil.example/x', '//127.0.0.1:1/x'])
      expect(
        await ask(`GET /anthropic${path} HTTP/1.1\r\n\r\n`),
        path,
      ).toContain('a path on the route itself only')
    expect(seen).toEqual([])
    // A backslash is a path separator to URL parsing: the request stays on the route's own host.
    expect(
      await ask('GET /anthropic/\\evil.example/x HTTP/1.1\r\n\r\n'),
    ).toStartWith('HTTP/1.1 200')
    expect(seen.map((r) => r.host)).toEqual([new URL(api.url.origin).host])
    seen.length = 0
    const big = 'x'.repeat(200_000)
    expect(
      await ask(
        `POST /anthropic/v1/messages HTTP/1.1\r\ncontent-length: ${big.length}\r\n\r\n${big}`,
      ),
    ).toStartWith('HTTP/1.1 200')
    expect(seen).toEqual([
      { host: new URL(api.url.origin).host, length: 200_000 },
    ])
  } finally {
    s.server.close()
    s.up.server.close()
    api.stop(true)
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A ClientHello with the given extensions, as one record (or split into two). */
function clientHello(extensions: Buffer[], split = false) {
  const u16 = (n: number) => Buffer.from([n >> 8, n & 0xff])
  const exts = Buffer.concat(extensions)
  const body = Buffer.concat([
    Buffer.from([3, 3]),
    Buffer.alloc(32),
    Buffer.from([0]),
    u16(2),
    Buffer.from([0x13, 0x01]),
    Buffer.from([1, 0]),
    u16(exts.length),
    exts,
  ])
  const handshake = Buffer.concat([
    Buffer.from([1, 0, body.length >> 8, body.length & 0xff]),
    body,
  ])
  const record = (b: Buffer) =>
    Buffer.concat([Buffer.from([0x16, 3, 1]), u16(b.length), b])
  if (!split) return record(handshake)
  const half = Math.floor(handshake.length / 2)
  return Buffer.concat([
    record(handshake.subarray(0, half)),
    record(handshake.subarray(half)),
  ])
}
const sni = (...names: string[]) => {
  const entries = Buffer.concat(
    names.map((n) =>
      Buffer.concat([
        Buffer.from([0, n.length >> 8, n.length & 0xff]),
        Buffer.from(n),
      ]),
    ),
  )
  const list = Buffer.concat([
    Buffer.from([entries.length >> 8, entries.length & 0xff]),
    entries,
  ])
  return Buffer.concat([
    Buffer.from([0, 0, list.length >> 8, list.length & 0xff]),
    list,
  ])
}
const ext = (type: number, data = Buffer.alloc(0)) =>
  Buffer.concat([
    Buffer.from([type >> 8, type & 0xff, data.length >> 8, data.length & 0xff]),
    data,
  ])

test('the server name is read only from one plain, whole ClientHello', () => {
  expect(
    serverName(
      clientHello([
        ext(10, Buffer.from([0, 2, 0, 29])),
        sni('registry.example.test'),
      ]),
    ),
  ).toBe('registry.example.test')
  // Ambiguous or hidden names count as none, so the connection is refused.
  expect(
    serverName(
      clientHello([sni('registry.example.test'), sni('evil.example')]),
    ),
  ).toBeUndefined()
  expect(
    serverName(clientHello([sni('registry.example.test', 'evil.example')])),
  ).toBeUndefined()
  // Any encrypted_client_hello is refused: the VM could hide another site's name inside.
  expect(
    serverName(
      clientHello([
        sni('registry.example.test'),
        ext(0xfe0d, Buffer.alloc(250)),
      ]),
    ),
  ).toBeUndefined()
  expect(
    serverName(
      clientHello([sni('registry.example.test'), ext(0xffce, Buffer.alloc(8))]),
    ),
  ).toBeUndefined()
  expect(
    serverName(clientHello([sni('registry.example.test')], true)),
  ).toBeUndefined()
  expect(serverName(clientHello([]))).toBeUndefined()
  expect(serverName(Buffer.from('GET / HTTP/1.1\r\n'))).toBeUndefined()
})

test('a malformed request ends that connection only; the station keeps serving', async () => {
  const dir = scratch()
  const s = await station(dir)
  try {
    for (const head of [
      'GET\r\n\r\n',
      '\r\n\r\n',
      'CONNECT\r\n\r\n',
      'GET /x HTTP/1.1\r\nbad name(: x\r\n\r\n',
      'GET /x HTTP/1.1\r\nx: a\u0000b\r\n\r\n',
      'CONNECT [::1]:443 HTTP/1.1\r\n\r\n',
    ]) {
      const vm = await open(s.socketPath, head)
      expect(await firstReply(vm), JSON.stringify(head)).toMatch(
        /^HTTP\/1\.1 400/,
      )
      vm.destroy()
    }
    const vm = await open(
      s.socketPath,
      'CONNECT other.example:443 HTTP/1.1\r\n\r\n',
    )
    expect(await firstReply(vm)).toContain('not on the whitelist')
  } finally {
    s.server.close()
    s.up.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a credential that can't be had: a fixed answer, never the vault's error, and no hammering", async () => {
  const dir = scratch()
  let asked = 0
  const s = await station(dir, {
    routes: {
      anthropic: {
        upstream: 'http://127.0.0.1:9',
        header: 'x-api-key',
        credential: async () => {
          asked++
          throw new Error(
            'vault at /Users/sami/secret path said no: token sk-partial',
          )
        },
      },
    },
  })
  try {
    for (let i = 0; i < 3; i++) {
      const vm = await open(
        s.socketPath,
        'GET /anthropic/v1/models HTTP/1.1\r\n\r\n',
      )
      const reply = await firstReply(vm)
      expect(reply).toContain('no credential for this route')
      expect(reply).not.toContain('sk-partial')
      vm.destroy()
    }
    expect(asked).toBe(1)
    expect(s.audit()).not.toContain('sk-partial')
  } finally {
    s.server.close()
    s.up.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a route's own code failing ends that request only; the station keeps serving", async () => {
  const dir = scratch()
  const s = await station(dir, {
    routes: {
      broken: {
        upstream: 'http://127.0.0.1:9',
        header: 'x-api-key',
        credential: async () => 'k',
        format: () => {
          throw new Error('format failed')
        },
      },
    },
  })
  try {
    const vm = await open(s.socketPath, 'GET /broken/x HTTP/1.1\r\n\r\n')
    await new Promise((r) => vm.once('close', r))
    const next = await open(
      s.socketPath,
      'CONNECT other.example:443 HTTP/1.1\r\n\r\n',
    )
    expect(await firstReply(next)).toContain('not on the whitelist')
  } finally {
    s.server.close()
    s.up.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

const helloFor = (host: string) => clientHello([sni(host)])

test('a VM that leaves while the station looks the name up leaves nothing behind', async () => {
  const dir = scratch()
  let lookups = 0
  const s = await station(dir, {
    resolve: async () => {
      lookups++
      await new Promise((r) => setTimeout(r, 300))
      return ['104.16.24.34']
    },
  })
  try {
    const vm = await open(
      s.socketPath,
      'CONNECT registry.example.test:443 HTTP/1.1\r\n\r\n',
    )
    expect(await firstReply(vm)).toStartWith('HTTP/1.1 200')
    vm.write(helloFor('registry.example.test'))
    await new Promise((r) => setTimeout(r, 50))
    vm.destroy()
    await new Promise((r) => setTimeout(r, 500))
    expect(lookups).toBe(1)
    expect(s.up.dialed).toEqual([])
    expect(s.audit()).toMatch(/closed by the VM|VM side error/)
  } finally {
    s.server.close()
    s.up.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a refused connection frees its slot even if the VM keeps its side open', async () => {
  const dir = scratch()
  const s = await station(dir)
  const connections = () =>
    new Promise<number>((r) => s.server.getConnections((_, n) => r(n)))
  try {
    const vm = connect({ path: s.socketPath, allowHalfOpen: true })
    await new Promise<void>((r) => vm.once('connect', () => r()))
    vm.write('CONNECT other.example:443 HTTP/1.1\r\n\r\n')
    vm.on('data', () => {})
    await new Promise((r) => setTimeout(r, 200))
    expect(await connections()).toBe(1)
    // The VM never closes its side; the station cuts the connection anyway.
    await new Promise((r) => setTimeout(r, 2600))
    expect(await connections()).toBe(0)
    vm.destroy()
  } finally {
    s.server.close()
    s.up.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('each checked address is tried in turn until one answers', async () => {
  const dir = scratch()
  const s0 = upstream()
  const dialed: string[] = []
  const s = await station(dir, {
    resolve: async () => ['104.16.24.34', '8.8.8.8'],
    dial: (address, port) => {
      dialed.push(address)
      // The first address is dead: nothing listens on port 1.
      return address === '104.16.24.34'
        ? connect({ host: '127.0.0.1', port: 1 })
        : connect({
            host: '127.0.0.1',
            port: (s0.server.address() as { port: number }).port,
          })
    },
  })
  try {
    const vm = await open(
      s.socketPath,
      'CONNECT registry.example.test:443 HTTP/1.1\r\n\r\n',
    )
    expect(await firstReply(vm)).toStartWith('HTTP/1.1 200')
    vm.write(helloFor('registry.example.test'))
    await new Promise((r) => setTimeout(r, 500))
    expect(dialed).toEqual(['104.16.24.34', '8.8.8.8'])
    expect(s0.bytes()[0]).toBe(0x16)
    vm.destroy()
  } finally {
    s.server.close()
    s.up.server.close()
    s0.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a route's key is used only on the paths it allows", async () => {
  const dir = scratch()
  const hits: string[] = []
  const api = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (r) => (hits.push(new URL(r.url).pathname), Response.json({})),
  })
  const s = await station(dir, {
    routes: {
      anthropic: {
        upstream: api.url.origin,
        header: 'x-api-key',
        credential: async () => 'k',
        paths: ['/v1/messages'],
      },
    },
  })
  try {
    for (const path of [
      '/v1/messages/../files',
      '/v1/messages/%2e%2e/files',
      '/v1/messages%2f..%2ffiles',
      '/v1/messages/..%2ffiles',
      '/v1/messagesX',
    ]) {
      const c = await open(
        s.socketPath,
        `POST /anthropic${path} HTTP/1.1\r\ncontent-length: 2\r\n\r\n{}`,
      )
      expect(await firstReply(c), path).toContain(
        'not a path this route allows',
      )
    }
    const files = await open(
      s.socketPath,
      'DELETE /anthropic/v1/files/f1 HTTP/1.1\r\n\r\n',
    )
    expect(await firstReply(files)).toContain('not a path this route allows')
    const ok = await open(
      s.socketPath,
      'POST /anthropic/v1/messages HTTP/1.1\r\ncontent-length: 2\r\n\r\n{}',
    )
    expect(await firstReply(ok)).toStartWith('HTTP/1.1 200')
    expect(hits).toEqual(['/v1/messages'])
  } finally {
    s.server.close()
    s.up.server.close()
    api.stop(true)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('one VM holds at most 64 connections', async () => {
  const dir = scratch()
  const s = await station(dir)
  const held: Socket[] = []
  try {
    // 64 connections waiting for their heads hold every slot.
    for (let i = 0; i < 64; i++) {
      const c = connect(s.socketPath)
      c.on('error', () => {})
      await new Promise<void>((r) => c.once('connect', () => r()))
      held.push(c)
    }
    const extra = connect(s.socketPath)
    extra.on('error', () => {})
    const closed = await Promise.race([
      new Promise((r) => extra.once('close', () => r(true))),
      new Promise((r) => setTimeout(() => r(false), 1500)),
    ])
    expect(closed).toBe(true)
  } finally {
    for (const c of held) c.destroy()
    s.server.close()
    s.up.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A server that answers the first hello with a HelloRetryRequest and records what follows. */
function retryingUpstream() {
  const received: Buffer[] = []
  const hrr = (() => {
    const random = Buffer.from(
      'cf21ad74e59a6111be1d8c021e65b891c2a211167abb8c5e079e09e2c8a8339c',
      'hex',
    )
    const body = Buffer.concat([
      Buffer.from([3, 3]),
      random,
      Buffer.from([0, 0x13, 0x01, 0, 0, 0]),
    ])
    const handshake = Buffer.concat([Buffer.from([2, 0, 0, body.length]), body])
    return Buffer.concat([
      Buffer.from([0x16, 3, 3, 0, handshake.length]),
      handshake,
    ])
  })()
  const server = createServer((s) => {
    let first = true
    s.on('data', (c) => {
      received.push(c)
      if (first) {
        first = false
        s.write(hrr)
      }
    })
  })
  server.listen(0, '127.0.0.1')
  const dial = () =>
    connect({
      host: '127.0.0.1',
      port: (server.address() as { port: number }).port,
    })
  return { server, received, dial, hrr }
}

test('after a HelloRetryRequest, the second ClientHello must name the same host', async () => {
  for (const [second, passes] of [
    ['registry.example.test', true],
    ['evil.example', false],
  ] as const) {
    const dir = scratch()
    const up = retryingUpstream()
    const s = await station(dir, { dial: up.dial })
    try {
      const vm = await open(
        s.socketPath,
        'CONNECT registry.example.test:443 HTTP/1.1\r\n\r\n',
      )
      expect(await firstReply(vm)).toStartWith('HTTP/1.1 200')
      const fromServer: Buffer[] = []
      vm.on('data', (c) => fromServer.push(c))
      vm.write(helloFor('registry.example.test'))
      await new Promise((r) => setTimeout(r, 200))
      // The VM gets the retry request, then sends a ChangeCipherSpec and its second hello.
      expect(Buffer.concat(fromServer).equals(up.hrr)).toBe(true)
      vm.write(
        Buffer.concat([Buffer.from([0x14, 3, 3, 0, 1, 1]), helloFor(second)]),
      )
      await new Promise((r) => setTimeout(r, 300))
      const seen = Buffer.concat(up.received)
      expect(seen.includes(Buffer.from(second)), second).toBe(passes)
      if (!passes)
        expect(s.audit()).toContain(
          `second TLS server name ${second} isn't the host`,
        )
      vm.destroy()
    } finally {
      s.server.close()
      s.up.server.close()
      up.server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
})
