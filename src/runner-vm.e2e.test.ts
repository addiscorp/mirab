// A CI runner's VM, live (vz on a Mac, Firecracker on Linux): nothing of the
// host's inside (no work share or drive), a root disk grown to the size asked
// and filled out while mounted (GROW_ROOT_FS), and no way back to the host.
// Needs a VM guest image described in $TEST_VM_CONFIG_DIR/isolation.json.
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { loadHostConfig, startVm, vmBackend } from './isolation'
import type { Isolation } from './isolation/session'
import { GROW_ROOT_FS } from './images'
import { EGRESS_GUEST_PORT, EGRESS_HOST_PORT } from './isolation/vz'

const testConfig = process.env.TEST_VM_CONFIG_DIR

async function sh(iso: Isolation, cmd: string) {
  const lines: string[] = []
  const code = await iso.exec(['sh', '-c', cmd], {
    cwd: '/',
    env: {
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    },
    timeoutMs: 120_000,
    signal: new AbortController().signal,
    onLine: async (l) => void lines.push(l),
  })
  return { code, out: lines.join('\n') }
}

describe.skipIf(!testConfig)('runner VM, live', () => {
  test('no host share, a 6 GiB root grown online, and no guest-to-host port', async () => {
    const host = await loadHostConfig(testConfig!)
    await mkdir(resolve('.tmp'), { recursive: true })
    const base = await mkdtemp(join(resolve('.tmp'), 'runner-vm-'))
    const iso = await startVm(
      { ...host.vm!, egress: 'block' },
      null,
      join(base, 'vm'),
      undefined,
      undefined,
      { rootGiB: 6, listen: [] },
    )
    try {
      // Nothing mounted at /workspace: no virtio-fs share, no second drive.
      const mounts = await sh(iso, 'cat /proc/mounts')
      expect(mounts.code).toBe(0)
      expect(mounts.out).not.toMatch(/ \/workspace /)
      expect((await sh(iso, 'ls /dev/vdb')).code).not.toBe(0)

      // The guest sees the grown disk, and the filesystem fills it while mounted.
      const sectors = await sh(iso, 'cat /sys/block/vda/size')
      expect(Number(sectors.out.trim()) * 512).toBe(6 * 1024 ** 3)
      const resize = await sh(iso, GROW_ROOT_FS)
      expect(resize.code).toBe(0)
      const df = await sh(iso, 'df -B1 --output=size / | tail -1')
      expect(Number(df.out.trim())).toBeGreaterThan(5 * 1024 ** 3)

      // A guest connection to the station's port reaches nobody on the host,
      // even with a server listening there: the VM forwards no port back.
      let reached = 0
      await iso.onGuestConnect!(EGRESS_HOST_PORT, async (socketPath) => {
        const server = createServer((c) => {
          reached++
          c.destroy()
        })
        await new Promise<void>((r) => server.listen(socketPath, r))
        return server
      })
      await sh(
        iso,
        `curl -sS -m 5 -x http://127.0.0.1:${EGRESS_GUEST_PORT} http://example.com/ >/dev/null 2>&1; true`,
      )
      if (vmBackend() === 'vz') expect(reached).toBe(0)
    } finally {
      await iso.close()
      await rm(base, { recursive: true, force: true })
    }
  }, 300_000)
})
