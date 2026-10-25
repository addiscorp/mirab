// Agent images (docs/architecture.md section 5b): an agent's `packages`,
// installed with apt on the release's base image, built once and cached under
// the hash of the base and the package list; updated by booting the image and
// running apt again. Both happen in a mirab VM whose only way out is the
// station, with only Ubuntu's mirrors on its whitelist, so vz and Firecracker
// build and update images the same way: each VM has its own copy of the root
// disk, and the one apt ran in is the one kept.
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { startVm, type VmConfig } from './isolation'
import type { Isolation } from './isolation/session'
import { EGRESS_GUEST_PORT, EGRESS_HOST_PORT } from './isolation/vz'
import { startEgress } from './station/egress'

/** Where apt goes, over HTTPS: the station lets nothing else out. */
export const UBUNTU_MIRRORS = [
  'archive.ubuntu.com',
  'security.ubuntu.com',
  'ports.ubuntu.com',
]
/** How long one apt step may take (a big install included). */
const APT_TIMEOUT_MS = 30 * 60_000
const ROOT_ENV = {
  PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
  HOME: '/root',
  DEBIAN_FRONTEND: 'noninteractive',
  LANG: 'C.UTF-8',
}
/** In the VM: apt's mirrors over HTTPS, and the station as its proxy. */
const APT_SETUP = [
  "sed -i 's|http://|https://|g' /etc/apt/sources.list.d/ubuntu.sources",
  `printf 'Acquire::http::Proxy "http://127.0.0.1:${EGRESS_GUEST_PORT}";\\nAcquire::https::Proxy "http://127.0.0.1:${EGRESS_GUEST_PORT}";\\n' > /etc/apt/apt.conf.d/90mirab-station`,
].join(' && ')

export interface ImageMeta {
  key: string
  packages: string[]
  base: string
  builtAt: string
  updatedAt: string
  /** What the last update upgraded. */
  upgraded: string[]
}

export const imagesDir = (configDir: string) => join(configDir, 'images')

/** The base image, by what can be read without hashing 3 GB: where it is, its
 *  size and when it was written. A new base is a new key. */
export async function baseId(rootfs: string): Promise<string> {
  const path = await realpath(rootfs)
  const st = await stat(path)
  return `${path}:${st.size}:${Math.floor(st.mtimeMs)}`
}

/** The cache key: the base and the package list, order and repeats aside. */
export function imageKey(base: string, packages: string[]): string {
  const list = [...new Set(packages)].sort()
  return createHash('sha256')
    .update(JSON.stringify({ base, packages: list }))
    .digest('hex')
    .slice(0, 32)
}

export interface CachedImage {
  rootfs: string
  meta: ImageMeta
}

export async function cachedImage(
  configDir: string,
  key: string,
): Promise<CachedImage | undefined> {
  const dir = join(imagesDir(configDir), key)
  try {
    const meta = JSON.parse(
      await readFile(join(dir, 'meta.json'), 'utf8'),
    ) as ImageMeta
    const rootfs = join(dir, 'rootfs.ext4')
    await stat(rootfs)
    return { rootfs, meta }
  } catch {
    return undefined
  }
}

/** Runs one command as root in the VM; a failure carries the end of its output. */
async function run(iso: Isolation, argv: string[], log?: (l: string) => void) {
  const lines: string[] = []
  const code = await iso.exec(argv, {
    cwd: '/',
    env: ROOT_ENV,
    timeoutMs: APT_TIMEOUT_MS,
    signal: new AbortController().signal,
    onLine: async (line) => {
      lines.push(line)
      if (lines.length > 400) lines.shift()
      log?.(line)
    },
  })
  if (code !== 0)
    throw new Error(
      `${argv.slice(0, 2).join(' ')} failed (${code}): ${lines.slice(-8).join(' | ')}`,
    )
  return lines
}

/** A VM on `rootfs` whose apt can reach Ubuntu's mirrors through the station. */
async function bootForApt(o: {
  configDir: string
  vm: VmConfig
  rootfs: string
  key: string
  log?: (line: string) => void
}): Promise<{ iso: Isolation; cleanup: () => Promise<void> }> {
  await mkdir(imagesDir(o.configDir), { recursive: true, mode: 0o700 })
  const scratch = await mkdtemp(join(imagesDir(o.configDir), '.vm-'))
  const work = join(scratch, 'work')
  await mkdir(work)
  const iso = await startVm(
    { ...o.vm, rootfs: o.rootfs, egress: 'block' },
    work,
    join(scratch, 'vm'),
    o.log,
  )
  const cleanup = () => rm(scratch, { recursive: true, force: true })
  try {
    await iso.onGuestConnect!(EGRESS_HOST_PORT, (socketPath) =>
      startEgress({
        socketPath,
        zone: `image-${o.key.slice(0, 12)}`,
        allow: UBUNTU_MIRRORS,
        routes: {},
        auditLog: join(o.configDir, 'egress.log'),
      }),
    )
    await run(iso, ['sh', '-c', APT_SETUP])
    return { iso, cleanup }
  } catch (e) {
    await iso.close().catch(() => {})
    await cleanup()
    throw e
  }
}

/** Stops the VM and keeps its root disk as the image in `dir`, moving any
 *  image there now aside as the previous one. */
async function keep(
  iso: Isolation,
  dir: string,
  meta: ImageMeta,
): Promise<string> {
  await run(iso, ['sync'])
  const part = join(dir, `rootfs.ext4.${process.pid}.${Date.now()}`)
  await iso.close({ keepRoot: part })
  const rootfs = join(dir, 'rootfs.ext4')
  await rename(rootfs, join(dir, 'previous.rootfs.ext4')).catch(() => {})
  await rename(part, rootfs)
  await writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n')
  return rootfs
}

/** The agent's image: from the cache, or built now. */
export async function agentImage(o: {
  configDir: string
  vm: VmConfig
  packages: string[]
  log?: (line: string) => void
}): Promise<string> {
  const base = await baseId(o.vm.rootfs)
  const key = imageKey(base, o.packages)
  const hit = await cachedImage(o.configDir, key)
  if (hit) return hit.rootfs
  const packages = [...new Set(o.packages)].sort()
  o.log?.(`building the agent's image: ${packages.join(' ')}`)
  const dir = join(imagesDir(o.configDir), key)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const { iso, cleanup } = await bootForApt({ ...o, rootfs: o.vm.rootfs, key })
  try {
    await run(iso, ['apt-get', 'update'])
    // Names only (the manifest's schema): apt takes them as arguments, no shell.
    await run(
      iso,
      ['apt-get', 'install', '-y', '--no-install-recommends', ...packages],
      o.log,
    )
    await run(iso, ['apt-get', 'clean'])
    const now = new Date().toISOString()
    return await keep(iso, dir, {
      key,
      packages,
      base,
      builtAt: now,
      updatedAt: now,
      upgraded: [],
    })
  } catch (e) {
    await iso.close().catch(() => {})
    throw e
  } finally {
    await cleanup()
  }
}

/** The packages a dry-run `apt-get -s upgrade` would upgrade. */
export function upgradesIn(lines: string[]): string[] {
  return lines
    .map((l) => /^Inst (\S+)/.exec(l)?.[1])
    .filter((name): name is string => !!name)
}

/** Boots the agent's image and upgrades it in place when apt has anything
 *  newer; the image before stays as the previous one. */
export async function updateImage(o: {
  configDir: string
  vm: VmConfig
  packages: string[]
  log?: (line: string) => void
}): Promise<{ rootfs: string; upgraded: string[] }> {
  const base = await baseId(o.vm.rootfs)
  const key = imageKey(base, o.packages)
  const hit = await cachedImage(o.configDir, key)
  if (!hit) return { rootfs: await agentImage(o), upgraded: [] }
  const dir = join(imagesDir(o.configDir), key)
  const { iso, cleanup } = await bootForApt({ ...o, rootfs: hit.rootfs, key })
  try {
    await run(iso, ['apt-get', 'update'])
    const upgraded = upgradesIn(await run(iso, ['apt-get', '-s', 'upgrade']))
    if (!upgraded.length) {
      await iso.close()
      return { rootfs: hit.rootfs, upgraded }
    }
    o.log?.(`upgrading: ${upgraded.join(' ')}`)
    await run(
      iso,
      ['apt-get', 'upgrade', '-y', '-o', 'Dpkg::Options::=--force-confold'],
      o.log,
    )
    await run(iso, ['apt-get', 'clean'])
    const rootfs = await keep(iso, dir, {
      ...hit.meta,
      updatedAt: new Date().toISOString(),
      upgraded,
    })
    return { rootfs, upgraded }
  } catch (e) {
    await iso.close().catch(() => {})
    throw e
  } finally {
    await cleanup()
  }
}
