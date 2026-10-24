// The station opening the hosts it holds keys for, with real curl as the VM:
// curl trusts only the station's authority and talks to the station as its
// proxy; the "real" api.stripe.test is a local server with its own authority.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as httpsServer } from 'node:https'
import { connect, createServer, type Server } from 'node:net'
import { join, resolve } from 'node:path'
import { stationAuthority } from './ca'
import { startEgress } from './egress'
import { startIntercept, type Intercept } from './intercept'
import { Placeholders, referencesIn, swapHeaders } from './secrets'

const SECRETS = {
  'prod/shop/STRIPE_KEY': { hosts: ['api.stripe.test'] },
  'personal/github/TOKEN': { hosts: ['github.test', '*.github.test'] },
  'prod/odd/KEY': { hosts: ['api.stripe.test'] },
}
const REAL: Record<string, string> = {
  'prod/shop/STRIPE_KEY': 'sk_live_REAL',
  'personal/github/TOKEN': 'ghp_REAL',
  'prod/odd/KEY': 'sk_\u00e9_not_latin1',
}

let base: string
let proxyPort: number
let bridge: Server
let station: Server
let intercept: Intercept
let upstream: ReturnType<typeof httpsServer>
let auditLog: string
const placeholders = new Placeholders()
const stripe = () => placeholders.for('prod/shop/STRIPE_KEY')
const github = () => placeholders.for('personal/github/TOKEN')
const asked: string[] = []
const received: Record<string, any>[] = []
const last = () => received[received.length - 1]
let stationCA: string

beforeAll(async () => {
  await mkdir(resolve('.tmp'), { recursive: true })
  base = await mkdtemp(join(resolve('.tmp'), 'intercept-'))
  auditLog = join(base, 'egress.log')
  // The outside world: its own authority, a server for both test hosts that
  // says what it received.
  const world = await stationAuthority(join(base, 'world'))
  const worldLeaf = await world.leaf([
    'api.stripe.test',
    'github.test',
    'evil.test',
  ])
  upstream = httpsServer(
    { key: worldLeaf.key, cert: worldLeaf.cert },
    (req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const got = {
          host: req.headers.host,
          hosts: req.rawHeaders.filter(
            (_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === 'host',
          ).length,
          url: req.url,
          auth: req.headers.authorization ?? null,
          stripe: req.headers['x-stripe-key'] ?? null,
          body,
          proxy: req.headers['proxy-authorization'] ?? null,
          encoding: req.headers['accept-encoding'] ?? null,
        }
        received.push(got)
        // A careless host that echoes what it got, in a header and the body.
        res.setHeader('x-echo', String(got.auth))
        res.end(JSON.stringify(got))
      })
    },
  )
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
  const upstreamPort = (upstream.address() as { port: number }).port
  const authority = await stationAuthority(join(base, 'station-ca'))
  stationCA = join(base, 'station-ca', 'ca.pem')
  const entries: Record<string, unknown>[] = []
  intercept = await startIntercept({
    secrets: SECRETS,
    placeholders,
    value: async (secret) => (asked.push(secret), REAL[secret]),
    authority,
    audit: (e) => {
      entries.push(e)
      require('node:fs').appendFileSync(auditLog, JSON.stringify(e) + '\n')
    },
    resolve: async () => ['93.184.216.34'],
    upstream: async () => ({
      address: '127.0.0.1',
      port: upstreamPort,
      ca: world.cert,
    }),
  })
  const socketPath = join(base, 'e.sock')
  station = await startEgress({
    socketPath,
    zone: 'gg.addis.zone.intercept-test',
    allow: [],
    routes: {},
    auditLog,
    intercept,
  })
  // curl takes a TCP proxy; this stands in for the VM's loopback forwarder.
  bridge = createServer((c) => {
    const s = connect(socketPath)
    c.pipe(s)
    s.pipe(c)
    c.on('error', () => s.destroy())
    s.on('error', () => c.destroy())
  })
  await new Promise<void>((r) => bridge.listen(0, '127.0.0.1', r))
  proxyPort = (bridge.address() as { port: number }).port
})

afterAll(async () => {
  bridge?.close()
  station?.close()
  await intercept?.close()
  upstream?.close()
  await rm(base, { recursive: true, force: true })
})

/** curl as a tool in the VM: the station as its proxy, its authority as its
 *  only trust. Async: the station runs in this same process. */
async function run(args: string[], input?: string) {
  const p = Bun.spawn(['curl', '-sS', '--max-time', '15', ...args], {
    stdin: input === undefined ? 'ignore' : new Blob([input]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  return { code, out, err }
}
const via = (port: number, args: string[], input?: string) =>
  run(['-x', `http://127.0.0.1:${port}`, '--cacert', stationCA, ...args], input)
const curl = (args: string[], input?: string) => via(proxyPort, args, input)
const status = ['-w', '%{http_code}', '-o', '/dev/null']

test('a placeholder becomes the real key, on its own host, and only in the header', async () => {
  const r = await curl([
    '-H',
    `Authorization: Bearer ${stripe()}`,
    '-d',
    `body keeps ${stripe()}`,
    'https://api.stripe.test/v1/charges',
  ])
  expect(r.code).toBe(0)
  const got = last()
  expect(got.auth).toBe('Bearer sk_live_REAL')
  // A body is never rewritten: a placeholder there stays useless.
  expect(got.body).toBe(`body keeps ${stripe()}`)
  expect(got.proxy).toBeNull()
  expect(got.hosts).toBe(1)
  // The host echoed the key back; the VM gets the placeholder instead.
  expect(r.out).not.toContain('sk_live_REAL')
  expect(JSON.parse(r.out).auth).toBe(`Bearer ${stripe()}`)
  const audit = await readFile(auditLog, 'utf8')
  expect(audit).toContain('"used":["prod/shop/STRIPE_KEY"]')
  expect(audit).not.toContain('sk_live_REAL')
})

test("a placeholder sent to a host that isn't its own is refused, and nothing is read from harar", async () => {
  const before = asked.length
  const r = await curl([
    ...status,
    '-H',
    `Authorization: Bearer ${stripe()}`,
    'https://github.test/x',
  ])
  expect(r.out).toBe('403')
  expect(asked.length).toBe(before)
})

test('a placeholder this session never gave out is refused', async () => {
  const r = await curl([
    ...status,
    '-H',
    'Authorization: Bearer mirab-ph-000000000000000000000000',
    'https://api.stripe.test/v1/charges',
  ])
  expect(r.out).toBe('403')
})

test('Basic credentials, as git sends them, are swapped too', async () => {
  const r = await curl([
    '-u',
    `x-access-token:${github()}`,
    'https://github.test/repo.git/info/refs',
  ])
  expect(last().auth).toBe(
    `Basic ${Buffer.from('x-access-token:ghp_REAL').toString('base64')}`,
  )
  expect(r.out).not.toContain(
    Buffer.from('x-access-token:ghp_REAL').toString('base64'),
  )
})

test('a chunked upload goes through whole', async () => {
  const r = await curl(
    [
      '-H',
      'Transfer-Encoding: chunked',
      '-H',
      `X-Stripe-Key: ${stripe()}`,
      '--data-binary',
      '@-',
      'https://api.stripe.test/v1/upload',
    ],
    'x'.repeat(200_000),
  )
  expect(r.code).toBe(0)
  expect(last().body.length).toBe(200_000)
  expect(last().stripe).toBe('sk_live_REAL')
})

test('the Host header must be the host the tunnel was opened for', async () => {
  const r = await curl([
    ...status,
    '-H',
    'Host: github.test',
    '-H',
    `Authorization: Bearer ${github()}`,
    'https://api.stripe.test/',
  ])
  expect(r.out).toBe('421')
})

test("a VM that doesn't trust the station's authority can't be fooled into using it", async () => {
  const r = await run([
    '-x',
    `http://127.0.0.1:${proxyPort}`,
    'https://api.stripe.test/',
  ])
  expect(r.code).not.toBe(0)
})

test('an opened host still has to resolve to the public internet', async () => {
  const authority = await stationAuthority(join(base, 'station-ca'))
  const audit: Record<string, unknown>[] = []
  const inner = await startIntercept({
    secrets: SECRETS,
    placeholders,
    value: async (s) => REAL[s],
    authority,
    audit: (e) => void audit.push(e),
    resolve: async () => ['10.0.0.5'],
  })
  const socketPath = join(base, 'p.sock')
  const s = await startEgress({
    socketPath,
    zone: 'z',
    allow: [],
    routes: {},
    auditLog: join(base, 'p.log'),
    intercept: inner,
  })
  const b = createServer((c) => {
    const u = connect(socketPath)
    c.pipe(u)
    u.pipe(c)
  })
  await new Promise<void>((r) => b.listen(0, '127.0.0.1', r))
  const r = await via((b.address() as { port: number }).port, [
    ...status,
    'https://api.stripe.test/',
  ])
  expect(r.out).toBe('502')
  expect(JSON.stringify(audit)).toContain('not public')
  b.close()
  s.close()
  await inner.close()
})

test('references in a .env name secrets; values that are not references are left alone', () => {
  const refs = referencesIn(
    '# comment\nexport STRIPE_KEY=harar://prod/shop/STRIPE_KEY\nGH="harar://personal/github/TOKEN"\nPLAIN=hello\n',
  )
  expect([...refs]).toEqual([
    ['STRIPE_KEY', 'prod/shop/STRIPE_KEY'],
    ['GH', 'personal/github/TOKEN'],
  ])
})

test('a real value with a line break never becomes a header', async () => {
  const p = new Placeholders()
  const r = await swapHeaders(
    'api.stripe.test',
    ['authorization', `Bearer ${p.for('prod/shop/STRIPE_KEY')}`],
    p,
    SECRETS,
    async () => 'sk\r\nX-Evil: 1',
  )
  expect(r.ok).toBe(false)
})

test("the station checks the real host's certificate on its own way out", async () => {
  // The upstream's certificate is from the world's authority; the station is
  // told to trust a different one, so the upstream counts as an impostor.
  const stranger = await stationAuthority(join(base, 'stranger'))
  const audit: Record<string, unknown>[] = []
  const port = (upstream.address() as { port: number }).port
  const inner = await startIntercept({
    secrets: SECRETS,
    placeholders,
    value: async (s) => REAL[s],
    authority: await stationAuthority(join(base, 'station-ca')),
    audit: (e) => void audit.push(e),
    resolve: async () => ['93.184.216.34'],
    upstream: async () => ({ address: '127.0.0.1', port, ca: stranger.cert }),
  })
  const socketPath = join(base, 'c.sock')
  const s = await startEgress({
    socketPath,
    zone: 'z',
    allow: [],
    routes: {},
    auditLog: join(base, 'c.log'),
    intercept: inner,
  })
  const b = createServer((c) => {
    const u = connect(socketPath)
    c.pipe(u)
    u.pipe(c)
  })
  await new Promise<void>((r) => b.listen(0, '127.0.0.1', r))
  const r = await via((b.address() as { port: number }).port, [
    ...status,
    '-H',
    `Authorization: Bearer ${stripe()}`,
    'https://api.stripe.test/',
  ])
  expect(r.out).toBe('502')
  expect(JSON.stringify(audit)).toContain('upstream:')
  b.close()
  s.close()
  await inner.close()
})

test('an echoed key never comes back in a header either', async () => {
  const r = await curl([
    '-i',
    '-H',
    `Authorization: Bearer ${stripe()}`,
    'https://api.stripe.test/echo',
  ])
  expect(r.out).not.toContain('sk_live_REAL')
  expect(r.out.toLowerCase()).toContain(`x-echo: bearer ${stripe()}`)
  // Asked for a body the station can read.
  expect(last().encoding).toBe('identity')
})

/** A raw request, as a hostile VM could write it, through the station. */
async function rawRequest(request: string) {
  const p = Bun.spawn(
    [
      'bun',
      join(import.meta.dir, 'raw-tls-client.ts'),
      String(proxyPort),
      'api.stripe.test',
      stationCA,
    ],
    {
      stdin: new Blob([request]),
      stdout: 'pipe',
    },
  )
  const out = await new Response(p.stdout).text()
  await p.exited
  return out
}

test('a second Host header, an absolute URL or TRACE never carries a key', async () => {
  const before = received.length
  const auth = `Authorization: Bearer ${stripe()}`
  const twice = await rawRequest(
    `GET / HTTP/1.1\nHost: api.stripe.test\nhost: evil.test\n${auth}\nConnection: close\n\n`,
  )
  expect(twice).toStartWith('HTTP/1.1 421')
  const absolute = await rawRequest(
    `GET https://evil.test/x HTTP/1.1\nHost: api.stripe.test\n${auth}\nConnection: close\n\n`,
  )
  expect(absolute).toStartWith('HTTP/1.1 400')
  const trace = await curl([
    ...status,
    '-X',
    'TRACE',
    '-H',
    auth,
    'https://api.stripe.test/',
  ])
  expect(trace.out).toBe('405')
  expect(received.length).toBe(before)
})

test('a value outside plain ASCII still gets an answer, never a hung station', async () => {
  const r = await curl([
    ...status,
    '-H',
    `X-Odd: ${placeholders.for('prod/odd/KEY')}`,
    'https://api.stripe.test/',
  ])
  expect(r.out).toMatch(/^\d{3}$/)
})

test('Basic credentials without a placeholder pass exactly as sent', async () => {
  const p = new Placeholders()
  const binary = Buffer.from([0xff, 0xfe, 0x3a, 0x80]).toString('base64')
  const r = await swapHeaders(
    'api.stripe.test',
    ['authorization', `Basic ${binary}`],
    p,
    SECRETS,
    async () => 'x',
  )
  expect(r.ok && r.headers).toEqual(['authorization', `Basic ${binary}`])
})

test('a key split across body chunks is still taken back out', async () => {
  const { Redact } = await import('./intercept')
  const out: Buffer[] = []
  const t = new Redact([['sk_live_REAL', 'mirab-ph-x']])
  t.on('data', (c: Buffer) => out.push(c))
  const ended = new Promise((r) => t.on('end', r))
  for (const piece of ['{"a":"sk_li', 've_RE', 'AL","b":"sk_live_REAL"}'])
    t.write(Buffer.from(piece))
  t.end()
  await ended
  expect(Buffer.concat(out).toString()).toBe(
    '{"a":"mirab-ph-x","b":"mirab-ph-x"}',
  )
})

test('a key that holds another is taken out whole, longest first', async () => {
  const { Redact, redactText } = await import('./intercept')
  const pairs: [string, string][] = [
    ['tok', 'P1'],
    ['tok-secret-long', 'P2'],
  ]
  expect(redactText('a tok-secret-long b tok', pairs)).toBe('a P2 b P1')
  const out: Buffer[] = []
  const t = new Redact(pairs)
  t.on('data', (c: Buffer) => out.push(c))
  const ended = new Promise((r) => t.on('end', r))
  t.end(Buffer.from('tok-secret-long'))
  await ended
  expect(Buffer.concat(out).toString()).toBe('P2')
})

test('an empty value from harar is refused, never swapped in', async () => {
  const p = new Placeholders()
  const r = await swapHeaders(
    'api.stripe.test',
    ['authorization', `Bearer ${p.for('prod/shop/STRIPE_KEY')}`],
    p,
    SECRETS,
    async () => '',
  )
  expect(r.ok).toBe(false)
  // And an empty value never reaches the scrubber, which would loop on it.
  const { redactText } = await import('./intercept')
  expect(redactText('abc', [['', 'P']])).toBe('abc')
})
