// VM start options for CI runners: no host share, a bigger root disk, and no
// guest-to-host ports. The live checks are in src/runner-vm.e2e.test.ts.
import { expect, test } from 'bun:test'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { growDisk, vsockMembers } from './firecracker'
import { GUEST_TO_HOST_PORTS, vzRunArgs } from './vz'

const cfg = { kernel: '/k', vcpus: 2, memoryMiB: 1024 }
const args = (share: string | null, listen: number[]) =>
  vzRunArgs({
    cfg,
    root: '/r',
    uds: '/u',
    vmDir: '/d',
    share,
    net: 'nat',
    listen,
  })

test('vz: no work directory means no share device at all', () => {
  expect(args('/d/work', GUEST_TO_HOST_PORTS)).toContain('workspace=/d/work')
  const bare = args(null, GUEST_TO_HOST_PORTS)
  expect(bare).not.toContain('--share')
  expect(bare.some((a) => a.startsWith('workspace='))).toBe(false)
})

test('vz: an empty listen list forwards no guest-to-host port', () => {
  expect(
    args(null, GUEST_TO_HOST_PORTS).filter((a) => a === '--listen'),
  ).toHaveLength(GUEST_TO_HOST_PORTS.length)
  expect(args(null, [])).not.toContain('--listen')
})

test('a guest path with no work directory is the path itself', () => {
  const none = vsockMembers(async () => ({}) as never, '/u', null, [])
  expect(none.guestPath('/home/runner/x')).toBe('/home/runner/x')
  const work = vsockMembers(async () => ({}) as never, '/u', '/host/w', [])
  expect(work.guestPath('/host/w/a.txt')).toBe('/workspace/a.txt')
})

test('a root disk grows sparse to the size asked, and never shrinks', async () => {
  const dir = await mkdtemp(join(resolve('.tmp'), 'grow-'))
  try {
    const disk = join(dir, 'root.img')
    await writeFile(disk, Buffer.alloc(1024 * 1024))
    await growDisk(disk, 2)
    const st = await stat(disk)
    expect(st.size).toBe(2 * 1024 ** 3)
    // Sparse: the 2 GiB file uses about the 1 MiB written, not 2 GiB of disk.
    expect(st.blocks * 512).toBeLessThan(64 * 1024 * 1024)
    await growDisk(disk, 2) // same size: nothing to do
    await expect(growDisk(disk, 1)).rejects.toThrow(/never shrinks/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('vz: a macOS guest boots from its platform files, with no kernel or command line', () => {
  const mac = vzRunArgs({
    cfg: { ...cfg, macos: '/d/macos' },
    root: '/r',
    uds: '/u',
    vmDir: '/d',
    share: null,
    net: 'nat',
    listen: [],
  })
  expect(mac.slice(0, 3)).toEqual(['run', '--macos', '/d/macos'])
  expect(mac).not.toContain('--kernel')
  expect(mac).not.toContain('--cmdline')
  expect(mac[mac.indexOf('--rootfs') + 1]).toBe('/r')
  // Linux keeps its kernel and command line.
  const linux = args(null, [])
  expect(linux).toContain('--kernel')
  expect(linux).not.toContain('--macos')
})
