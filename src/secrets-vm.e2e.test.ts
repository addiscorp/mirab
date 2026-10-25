// Keys for any service in a real VM: the project's .env holds only harar://
// references, the VM's programs get placeholders, and unchanged curl, git and
// Bun reach "Stripe" and "GitHub" with the real keys, which the station adds
// on the way out and only on each key's own host. Needs a VM guest image
// described in $TEST_VM_CONFIG_DIR/isolation.json (docs/VM.md). The
// services are local stand-ins with their own authority; no real key is used.
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as httpsServer } from 'node:https'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { startVmChild } from './spawn-vm'
import { stationAuthority } from './station/ca'

const configDir = process.env.TEST_VM_CONFIG_DIR

describe.skipIf(!configDir)('keys for any service in a VM, live', () => {
  test('curl, git and Bun use the real keys through the station, and the VM only ever holds placeholders', async () => {
    await mkdir(resolve('.tmp'), { recursive: true })
    const base = await mkdtemp(join(resolve('.tmp'), 'secrets-vm-'))
    const work = join(base, 'work')
    await mkdir(work)
    await writeFile(
      join(work, '.env'),
      'STRIPE_KEY=harar://prod/shop/STRIPE_KEY\nGH=harar://personal/github/TOKEN\n',
    )
    const REAL: Record<string, string> = {
      'prod/shop/STRIPE_KEY': 'sk_live_REAL123',
      'personal/github/TOKEN': 'ghp_REAL456',
    }
    // Where each may go is harar's to say: it answers hosts, and sends a
    // value only for one of them.
    const HOSTS: Record<string, string[]> = {
      'prod/shop/STRIPE_KEY': ['api.stripe.test'],
      'personal/github/TOKEN': ['github.test'],
    }
    const asked: string[] = []
    const harar = join(base, 'h.sock')
    const hararServer = createServer((conn) => {
      let body = ''
      conn.on('data', (c) => (body += c))
      conn.on('end', () => {
        const { op, key, host } = JSON.parse(body)
        asked.push(host ? `${op} ${key} ${host}` : `${op} ${key}`)
        if (op === 'hosts')
          return conn.end(JSON.stringify({ ok: true, hosts: HOSTS[key] ?? [] }))
        if (op === 'send' && HOSTS[key]?.includes(host))
          return conn.end(JSON.stringify({ ok: true, value: REAL[key] }))
        conn.end(JSON.stringify({ ok: false, error: 'no_binding' }))
      })
    })
    await new Promise<void>((r) => hararServer.listen(harar, r))
    // The outside world: its own authority, and a server that records what it got.
    const world = await stationAuthority(join(base, 'world'))
    const leaf = await world.leaf(['api.stripe.test', 'github.test'])
    const seen: { host?: string; path?: string; auth?: string }[] = []
    const api = httpsServer({ key: leaf.key, cert: leaf.cert }, (req, res) => {
      seen.push({
        host: req.headers.host,
        path: req.url,
        auth: req.headers.authorization,
      })
      // git asks again with its credentials only after a 401.
      if (!req.headers.authorization) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="t"' })
        return res.end()
      }
      res.end(`ok ${req.headers.host}`)
    })
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r))
    const port = (api.address() as { port: number }).port
    const auditLog = join(base, 'egress.log')
    const script = [
      'echo "holds: $STRIPE_KEY"',
      'curl -sS https://api.stripe.test/v1/charges -H "Authorization: Bearer $STRIPE_KEY"; echo',
      'git ls-remote "https://x-access-token:$GH@github.test/acme/repo.git" >/dev/null 2>&1; echo git=done',
      `bun -e "const r = await fetch('https://api.stripe.test/v1/bun', { headers: { authorization: 'Bearer ' + process.env.STRIPE_KEY } }); console.log('bun ' + r.status)"`,
      'echo wrong=$(curl -sS -o /dev/null -w "%{http_code}" https://github.test/x -H "Authorization: Bearer $STRIPE_KEY")',
      'echo real-in-vm=$( (env; cat .env) | grep -c REAL)',
    ].join('; ')
    const child = await startVmChild({
      configDir: configDir!,
      sessionId: 'secrets-e2e',
      cwd: work,
      binary: 'sh',
      args: ['-c', script],
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/root' },
      cols: 160,
      rows: 40,
      station: {
        config: {
          harar: { socket: harar },
          models: {},
        },
        auditLog,
        opened: async () => ({ address: '127.0.0.1', port, ca: world.cert }),
      },
    })
    let screen = ''
    child.onData((d) => (screen += d.toString()))
    try {
      const code = await new Promise<number>((r) =>
        child.onExit(({ exitCode }) => r(exitCode)),
      )
      expect(code).toBe(0)
      // The VM holds a placeholder, never the key.
      expect(screen).toMatch(/holds: mirab-ph-[0-9a-f]{24}/)
      // harar was asked where each may go, then for each send by host; never
      // for a plain read, and never for the key the VM aimed at the wrong host.
      expect(asked).toContain('hosts prod/shop/STRIPE_KEY')
      expect(asked).toContain('send prod/shop/STRIPE_KEY api.stripe.test')
      expect(asked).toContain('send personal/github/TOKEN github.test')
      expect(asked.some((a) => a.startsWith('get '))).toBe(false)
      expect(asked).not.toContain('send prod/shop/STRIPE_KEY github.test')
      expect(screen).toContain('ok api.stripe.test')
      expect(screen).toContain('bun 200')
      expect(screen).toContain('wrong=403')
      expect(screen).toContain('real-in-vm=0')
      expect(screen).not.toContain('REAL123')
      // What the services got: the real keys, each on its own host only.
      const stripeAuth = seen
        .filter((s) => s.host === 'api.stripe.test')
        .map((s) => s.auth)
      expect(stripeAuth).toEqual([
        'Bearer sk_live_REAL123',
        'Bearer sk_live_REAL123',
      ])
      const gitAuth = seen
        .filter((s) => s.host === 'github.test' && s.auth)
        .map((s) => s.auth)
      expect(gitAuth).toContain(
        `Basic ${Buffer.from('x-access-token:ghp_REAL456').toString('base64')}`,
      )
      expect(
        seen.some(
          (s) => s.host === 'github.test' && s.auth?.includes('sk_live'),
        ),
      ).toBe(false)
      const audit = await readFile(auditLog, 'utf8')
      expect(audit).not.toContain('REAL')
      expect(audit).toContain("doesn't go to github.test")
    } finally {
      await child.dispose().catch(() => {})
      api.close()
      hararServer.close()
      await rm(base, { recursive: true, force: true })
    }
  }, 180_000)
})
