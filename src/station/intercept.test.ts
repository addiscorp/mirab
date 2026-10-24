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
}
const REAL: Record<string, string> = {
  'prod/shop/STRIPE_KEY': 'sk_live_REAL',
  'personal/github/TOKEN': 'ghp_REAL',
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
      req.on('end', () =>
        res.end(
          JSON.stringify({
            host: req.headers.host,
            auth: req.headers.authorization ?? null,
            stripe: req.headers['x-stripe-key'] ?? null,
            body,
            proxy: req.headers['proxy-authorization'] ?? null,
          }),
        ),
      )
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
  const got = JSON.parse(r.out)
  expect(got.auth).toBe('Bearer sk_live_REAL')
  // A body is never rewritten: a placeholder there stays useless.
  expect(got.body).toBe(`body keeps ${stripe()}`)
  expect(got.proxy).toBeNull()
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
  expect(JSON.parse(r.out).auth).toBe(
    `Basic ${Buffer.from('x-access-token:ghp_REAL').toString('base64')}`,
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
  const got = JSON.parse(r.out)
  expect(got.body.length).toBe(200_000)
  expect(got.stripe).toBe('sk_live_REAL')
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
