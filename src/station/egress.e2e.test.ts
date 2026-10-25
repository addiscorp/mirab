// The way out of a real VM: a guest with no network of its own reaches a
// whitelisted domain only through the station, is refused anything else, and
// gets the model route's key added on the host. Needs a VM guest image
// described in $TEST_VM_CONFIG_DIR/isolation.json (docs/VM.md), and the
// internet for the whitelisted domain.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadHostConfig, startVm } from '../isolation/index'
import type { Isolation } from '../isolation/session'
import { EGRESS_HOST_PORT } from '../isolation/vz'
import { startEgress } from './egress'

const configDir = process.env.TEST_VM_CONFIG_DIR

async function run(iso: Isolation, cmd: string) {
  const lines: string[] = []
  const code = await iso.exec(['sh', '-c', cmd], {
    cwd: '/workspace',
    env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    timeoutMs: 30_000,
    signal: new AbortController().signal,
    onLine: async (l) => void lines.push(l),
  })
  return { code, out: lines.join('\n') }
}

describe.skipIf(!configDir)('the way out of a VM, live', () => {
  test('whitelisted through the station, everything else refused, the key added on the host', async () => {
    const host = await loadHostConfig(configDir!)
    const base = mkdtempSync(join(process.env.TMPDIR ?? '.', 'egress-e2e-'))
    const work = join(base, 'work')
    await Bun.write(join(work, '.keep'), '')
    // A stand-in for the model API, on the host: it says whether the real key arrived.
    const api = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) =>
        Response.json({
          realKey: request.headers.get('x-api-key') === 'sk-real-on-the-host',
          placeholderSeen: request.headers.get('x-api-key') === 'placeholder',
        }),
    })
    const auditLog = join(base, 'egress.log')
    const iso = await startVm(
      { ...host.vm!, egress: 'block' },
      work,
      join(base, 'vm'),
    )
    try {
      await iso.onGuestConnect!(EGRESS_HOST_PORT, (socketPath) =>
        startEgress({
          socketPath,
          zone: 'gg.addis.zone.vm-e2e',
          allow: ['registry.npmjs.org'],
          routes: {
            anthropic: {
              upstream: api.url.origin,
              header: 'x-api-key',
              credential: async () => 'sk-real-on-the-host',
            },
          },
          auditLog,
        }),
      )
      const proxy = '-x http://127.0.0.1:8790'
      // Whitelisted: through the station, TLS end to end (curl checks the real certificate).
      const npm = await run(
        iso,
        `curl -s -o /dev/null -w '%{http_code}' ${proxy} https://registry.npmjs.org/`,
      )
      expect(npm.out).toBe('200')
      // Bun (BoringSSL, as agents' tools and bun install use) through the station too.
      const bun = await run(
        iso,
        `HTTPS_PROXY=http://127.0.0.1:8790 bun -e "console.log((await fetch('https://registry.npmjs.org/')).status)"`,
      )
      expect(bun.out.trim()).toBe('200')
      // Not on the list: the station refuses the CONNECT.
      const other = await run(
        iso,
        `curl -s -o /dev/null -w '%{http_connect}' ${proxy} https://example.com/ || true`,
      )
      expect(other.out).toBe('403')
      // No way around the station: the VM has no network of its own.
      const direct = await run(
        iso,
        'curl -s -m 5 -o /dev/null https://registry.npmjs.org/; echo $?',
      )
      expect(direct.out).not.toBe('0')
      // The model route: the VM sends a placeholder, the real key is added on the host.
      const model = await run(
        iso,
        `curl -s -H 'x-api-key: placeholder' http://127.0.0.1:8790/anthropic/v1/check`,
      )
      expect(JSON.parse(model.out)).toEqual({
        realKey: true,
        placeholderSeen: false,
      })
      // Nothing in the VM ever held the key, and the audit never wrote it down.
      const env = await run(
        iso,
        'cat /proc/*/environ 2>/dev/null | tr "\\0" "\\n" | grep -c sk-real || true',
      )
      expect(env.out.trim()).toBe('0')
      // A tunnel's line is written when it closes, a moment after curl is done.
      let audit = ''
      for (let i = 0; i < 20 && !audit.includes('registry.npmjs.org'); i++) {
        await Bun.sleep(100)
        audit = readFileSync(auditLog, 'utf8')
      }
      expect(audit).not.toContain('sk-real')
      expect(audit).toContain('"host":"registry.npmjs.org"')
      expect(audit).toContain('not on the whitelist')
    } finally {
      await iso.close()
      api.stop(true)
    }
  }, 120_000)
})
