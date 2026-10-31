// macOS guests, live (Apple silicon): a VM booted from a provisioned macOS
// base (`mirab-vz macos-install`, then `sudo mirab-vz macos-provision`) must
// answer the guest agent on vsock, run a step as root, see macOS, and start
// from a fresh disk each time. Needs TEST_MACOS_BASE (the base directory) and
// TEST_VZ_HELPER (a signed mirab-vz).
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { startVz } from './isolation/vz'

const base = process.env.TEST_MACOS_BASE
const helper = process.env.TEST_VZ_HELPER

async function run(
  iso: Awaited<ReturnType<typeof startVz>>,
  argv: string[],
): Promise<{ code: number; out: string }> {
  let out = ''
  const code = await iso.exec(argv, {
    cwd: '/',
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    timeoutMs: 60_000,
    signal: new AbortController().signal,
    onLine: async (l) => void (out += l + '\n'),
  })
  return { code, out }
}

describe.skipIf(!base || !helper)('macOS guest, live', () => {
  test('boots, answers the agent, runs as root on macOS, and starts fresh every time', async () => {
    const dir = await mkdtemp(join(resolve('.tmp'), 'macos-'))
    const cfg = {
      helper: helper!,
      kernel: '',
      rootfs: join(base!, 'disk.img'),
      macos: base!,
      memoryMiB: 4096,
      vcpus: 2,
      port: 9002,
      egress: 'allow' as const,
    }
    const lines: string[] = []
    try {
      for (const round of [1, 2]) {
        const iso = await startVz(cfg, null, join(dir, `vm${round}`), (l) =>
          lines.push(l),
        )
        try {
          const os = await run(iso, ['/usr/bin/sw_vers', '-productName'])
          expect(os.code).toBe(0)
          expect(os.out).toContain('macOS')
          expect((await run(iso, ['/usr/bin/id', '-u'])).out.trim()).toBe('0')
          // Fresh disk: the first VM's marker is gone in the second.
          const seen = await run(iso, [
            '/bin/sh',
            '-c',
            'test -e /private/var/tmp/mirab-marker && echo reused || echo fresh; touch /private/var/tmp/mirab-marker',
          ])
          expect(seen.out.trim()).toBe('fresh')
        } finally {
          await iso.close()
        }
      }
      expect(lines.join('\n')).toMatch(/microVM ready in \d+ ms/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 900_000)
})
