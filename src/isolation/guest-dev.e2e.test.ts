// /dev in the guest, live: init-mirab.sh mounts a bare devtmpfs, which has
// device nodes only. Programs expect what udev or an initramfs add on a stock
// system: /dev/fd (bash process substitution), /dev/std{in,out,err}, and a
// writable tmpfs /dev/shm (POSIX shared memory, Chromium). Needs a VM guest
// image described in $TEST_VM_CONFIG_DIR/isolation.json (Firecracker or vz).
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { loadHostConfig, startVm } from './index'
import type { Isolation } from './session'

const testConfig = process.env.TEST_VM_CONFIG_DIR

async function bash(iso: Isolation, cmd: string) {
  const lines: string[] = []
  const code = await iso.exec(['bash', '-c', cmd], {
    cwd: '/',
    env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    timeoutMs: 60_000,
    signal: new AbortController().signal,
    onLine: async (l) => void lines.push(l),
  })
  return { code, out: lines.join('\n') }
}

describe.skipIf(!testConfig)('guest /dev, live', () => {
  test('process substitution, /dev/std{in,out,err} and a writable /dev/shm', async () => {
    const host = await loadHostConfig(testConfig!)
    await mkdir(resolve('.tmp'), { recursive: true })
    const base = await mkdtemp(join(resolve('.tmp'), 'guest-dev-'))
    const iso = await startVm(
      { ...host.vm!, egress: 'block' },
      null,
      join(base, 'vm'),
      undefined,
      undefined,
      { listen: [] },
    )
    try {
      // The failure in addiscorp/ava run 43348887518: /dev/fd/63 missing.
      const subst = await bash(iso, 'cat <(echo ok)')
      expect(subst).toEqual({ code: 0, out: 'ok' })

      // Each stream reaches its own descriptor through its /dev name.
      const streams = await bash(
        iso,
        'echo in | cat /dev/stdin; echo out > /dev/stdout; ' +
          '{ echo err > /dev/stderr; } 2>&1; ' +
          'readlink /dev/stdin /dev/stdout /dev/stderr /dev/fd',
      )
      expect(streams.code).toBe(0)
      expect(streams.out.split('\n')).toEqual([
        'in',
        'out',
        'err',
        '/proc/self/fd/0',
        '/proc/self/fd/1',
        '/proc/self/fd/2',
        '/proc/self/fd',
      ])

      // /dev/shm: its own tmpfs, sticky and world-writable, and POSIX shared
      // memory (shm_open, which glibc puts in /dev/shm) works in it.
      const shm = await bash(
        iso,
        'awk \'$2 == "/dev/shm" { print $3 }\' /proc/mounts; stat -c %a /dev/shm; ' +
          'python3 -c "from multiprocessing import shared_memory as s; ' +
          'm = s.SharedMemory(create=True, size=64); m.buf[0] = 7; ' +
          "n = s.SharedMemory(m.name); print('shm', n.buf[0]); n.close(); m.close(); m.unlink()\" 2>&1",
      )
      expect(shm.out.split('\n')).toEqual(['tmpfs', '1777', 'shm 7'])
      expect(shm.code).toBe(0)
    } finally {
      await iso.close()
      await rm(base, { recursive: true, force: true })
    }
  }, 300_000)
})
