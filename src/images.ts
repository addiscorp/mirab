// Agent images (docs/architecture.md section 5b): an agent's `packages`,
// installed with apt on the release's base image, built once and cached under
// the hash of the base and the package list; updated by booting the image and
// running apt again. Both happen in a mirab VM whose only way out is the
// station, with only Ubuntu's mirrors on its whitelist, so vz and Firecracker
// build and update images the same way: each VM has its own copy of the root
// disk, and the one apt ran in is the one kept.
import { createHash } from 'node:crypto'
import {
  link,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { startVm, type VmConfig } from './isolation'
import type { Isolation } from './isolation/session'
import { EGRESS_GUEST_PORT, EGRESS_HOST_PORT } from './isolation/vz'
import { startEgress } from 'rixse'

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

/** The base image: where it is, its size, when it was written, and a hash of
 *  its first 4 MB (the filesystem's superblock and early blocks), without
 *  reading all 3 GB. A new base is a new key. */
export async function baseId(rootfs: string): Promise<string> {
  const path = await realpath(rootfs)
  const st = await stat(path)
  const handle = await open(path, 'r')
  try {
    const head = Buffer.alloc(Math.min(st.size, 4 * 1024 * 1024))
    await handle.read(head, 0, head.length, 0)
    const sum = createHash('sha256').update(head).digest('hex').slice(0, 16)
    return `${path}:${st.size}:${Math.floor(st.mtimeMs)}:${sum}`
  } finally {
    await handle.close()
  }
}

/** A cache key for any build recipe: the base plus the recipe as canonical
 *  JSON (object keys sorted at every level), so equal recipes share a key. */
export function recipeKey(base: string, recipe: unknown): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v as object)
              .sort()
              .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
          )
        : v
  return createHash('sha256')
    .update(JSON.stringify({ base, recipe: canon(recipe) }))
    .digest('hex')
    .slice(0, 32)
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
  base?: string,
): Promise<CachedImage | undefined> {
  const dir = join(imagesDir(configDir), key)
  try {
    const meta = JSON.parse(
      await readFile(join(dir, 'meta.json'), 'utf8'),
    ) as ImageMeta
    // Built on another base (a key collision, or a base changed in place): a miss.
    if (base !== undefined && meta.base !== base) return undefined
    const rootfs = join(dir, 'rootfs.ext4')
    await stat(rootfs)
    return { rootfs, meta }
  } catch {
    return undefined
  }
}

/** In a build VM: tools other than apt (curl, rustup) reach the station too. */
export const BUILD_ENV = {
  ...ROOT_ENV,
  HTTP_PROXY: `http://127.0.0.1:${EGRESS_GUEST_PORT}`,
  HTTPS_PROXY: `http://127.0.0.1:${EGRESS_GUEST_PORT}`,
  http_proxy: `http://127.0.0.1:${EGRESS_GUEST_PORT}`,
  https_proxy: `http://127.0.0.1:${EGRESS_GUEST_PORT}`,
  NO_PROXY: 'localhost,127.0.0.1',
}

/** Runs one command as root in the VM; a failure carries the end of its output. */
export async function run(
  iso: Pick<Isolation, 'exec'>,
  argv: string[],
  log?: (l: string) => void,
  env: Record<string, string> = BUILD_ENV,
) {
  const lines: string[] = []
  const code = await iso.exec(argv, {
    cwd: '/',
    env,
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

/** A build VM on `rootfs` whose only way out is the station, to the hosts in
 *  `allow` (default: Ubuntu's mirrors, for apt). `rootGiB` grows its root
 *  disk first; the build then grows the filesystem (resize2fs). */
export async function bootForBuild(o: {
  configDir: string
  vm: VmConfig
  rootfs: string
  key: string
  allow?: string[]
  rootGiB?: number
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
    undefined,
    { rootGiB: o.rootGiB },
  )
  const cleanup = () => rm(scratch, { recursive: true, force: true })
  try {
    await iso.onGuestConnect!(EGRESS_HOST_PORT, (socketPath) =>
      startEgress({
        socketPath,
        zone: `image-${o.key.slice(0, 12)}`,
        allow: o.allow ?? UBUNTU_MIRRORS,
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

/** Grows the running guest's root filesystem to fill its (grown) disk, while
 *  mounted. resize2fs can't: the kernel mounts the root as /dev/root, so it
 *  doesn't see /dev/vda as mounted and refuses an exclusive open. This is the
 *  ioctl resize2fs itself uses online (EXT4_IOC_RESIZE_FS). */
export const GROW_ROOT_FS =
  "python3 -c \"import fcntl,os,struct; f=os.open('/',os.O_RDONLY); " +
  "n=int(open('/sys/block/vda/size').read())*512//os.statvfs('/').f_bsize; " +
  "fcntl.ioctl(f,0x40086610,struct.pack('Q',n))\""

/** Stops the VM and keeps its root disk as the image in `dir`, moving any
 *  image there now aside as the previous one. */
export async function keep(
  iso: Pick<Isolation, 'exec' | 'close'>,
  dir: string,
  meta: object,
  opts: { previous?: boolean } = {},
): Promise<string> {
  // The station's proxy is only for building; sessions use their own station.
  await run(iso, [
    'sh',
    '-c',
    'rm -f /etc/apt/apt.conf.d/90mirab-station && sync',
  ])
  const tag = `${process.pid}.${Date.now()}`
  const part = join(dir, `rootfs.ext4.${tag}`)
  try {
    await iso.close({ keepRoot: part })
  } catch (e) {
    await rm(part, { force: true })
    throw e
  }
  // The new image is whole before anything moves: the old one is kept by a
  // second name, then replaced in one rename, so there is always an image.
  const rootfs = join(dir, 'rootfs.ext4')
  const previous = join(dir, 'previous.rootfs.ext4')
  const metaPart = join(dir, `meta.json.${tag}`)
  await writeFile(metaPart, JSON.stringify(meta, null, 2) + '\n')
  await rm(previous, { force: true })
  // Agent images keep the one before; rebuildable images (runners) don't.
  if (opts.previous !== false) await link(rootfs, previous).catch(() => {})
  await rename(part, rootfs)
  await rename(metaPart, join(dir, 'meta.json'))
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
  const hit = await cachedImage(o.configDir, key, base)
  if (hit) {
    // When it was last used, for `mirab image prune`.
    const now = new Date()
    await utimes(
      join(imagesDir(o.configDir), key, 'meta.json'),
      now,
      now,
    ).catch(() => {})
    return hit.rootfs
  }
  const packages = [...new Set(o.packages)].sort()
  o.log?.(`building the agent's image: ${packages.join(' ')}`)
  const dir = join(imagesDir(o.configDir), key)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const { iso, cleanup } = await bootForBuild({
    ...o,
    rootfs: o.vm.rootfs,
    key,
  })
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
  const hit = await cachedImage(o.configDir, key, base)
  if (!hit) return { rootfs: await agentImage(o), upgraded: [] }
  const dir = join(imagesDir(o.configDir), key)
  const { iso, cleanup } = await bootForBuild({ ...o, rootfs: hit.rootfs, key })
  try {
    await run(iso, ['apt-get', 'update'])
    const upgraded = upgradesIn(await run(iso, ['apt-get', '-s', 'upgrade']))
    if (!upgraded.length) {
      await iso.close()
      const now = new Date()
      await utimes(join(dir, 'meta.json'), now, now).catch(() => {})
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

export interface ListedImage {
  key: string
  packages: string[]
  /** Built on the base this mirab boots now; otherwise it is never used again. */
  current: boolean
  /** When it was built, updated or booted last. */
  usedAt: Date
  bytes: number
}

/** Bytes on disk (images are sparse), not length: an image and the copy an update keeps (`previous.rootfs.ext4`), counted
 *  once where they are still the same file. */
async function imageBytes(dir: string) {
  const now = await stat(join(dir, 'rootfs.ext4'))
  const before = await stat(join(dir, 'previous.rootfs.ext4')).catch(
    () => undefined,
  )
  return (
    now.blocks * 512 +
    (before && before.ino !== now.ino ? before.blocks * 512 : 0)
  )
}

const DAY_MS = 86_400_000
/** Used this recently, an image is never removed: a `mirab dev` that just
 *  found it in the cache may be about to boot it. */
const IN_USE_MS = 60 * 60 * 1000

/** Every cached agent image, newest use first. */
export async function listImages(
  configDir: string,
  currentBase: string,
): Promise<ListedImage[]> {
  let names: string[] = []
  try {
    names = await readdir(imagesDir(configDir))
  } catch {
    return []
  }
  const out: ListedImage[] = []
  for (const key of names) {
    if (!/^[0-9a-f]{32}$/.test(key)) continue
    const dir = join(imagesDir(configDir), key)
    try {
      const hit = await cachedImage(configDir, key)
      if (!hit) continue
      const meta = await stat(join(dir, 'meta.json'))
      out.push({
        key,
        packages: hit.meta.packages,
        current: hit.meta.base === currentBase,
        usedAt: meta.mtime,
        bytes: await imageBytes(dir),
      })
    } catch {
      // Gone, or going, as it was read: not one to list.
    }
  }
  return out.sort((a, b) => b.usedAt.getTime() - a.usedAt.getTime())
}

/**
 * What `mirab image prune` removes: images built on a base this mirab no
 * longer boots (after an upgrade they are never used again), images unused
 * for `days` (at least one), and what a build left behind a day or more ago:
 * scratch and an image directory that never got as far as its meta.json. An
 * image used in the last hour always stays, and a VM boots from its own copy,
 * so a running one is never touched. One that can't be removed is reported,
 * and the rest go on.
 */
export async function pruneImages(o: {
  configDir: string
  currentBase: string
  days: number
  dryRun?: boolean
  now?: Date
}): Promise<{
  removed: { key: string; why: string; bytes: number }[]
  failed: { key: string; error: string }[]
}> {
  if (!Number.isInteger(o.days) || o.days < 1)
    throw new Error('days is a whole number, at least 1')
  const now = (o.now ?? new Date()).getTime()
  const removed: { key: string; why: string; bytes: number }[] = []
  const failed: { key: string; error: string }[] = []
  const remove = async (key: string, why: string, bytes: number) => {
    try {
      if (!o.dryRun)
        await rm(join(imagesDir(o.configDir), key), {
          recursive: true,
          force: true,
        })
      removed.push({ key, why, bytes })
    } catch (e) {
      failed.push({ key, error: (e as Error).message })
    }
  }
  const images = await listImages(o.configDir, o.currentBase)
  for (const image of images) {
    // Looked at again just before it goes: a use since the list keeps it.
    const meta = await stat(
      join(imagesDir(o.configDir), image.key, 'meta.json'),
    ).catch(() => undefined)
    if (!meta || now - meta.mtimeMs < IN_USE_MS) continue
    const idle = (now - meta.mtimeMs) / DAY_MS
    const why = !image.current
      ? 'built on an older base'
      : idle >= o.days
        ? `unused for ${Math.floor(idle)} days`
        : undefined
    if (why) await remove(image.key, why, image.bytes)
  }
  // What a build left: scratch, and an image's directory that never got its
  // meta.json; only once a day old, so a build under way keeps its own.
  const listed = new Set(images.map((i) => i.key))
  let names: string[] = []
  try {
    names = await readdir(imagesDir(o.configDir))
  } catch {}
  // Sorted, so what it says is the same on every filesystem.
  for (const name of names.sort()) {
    const leftover =
      name.startsWith('.vm-') ||
      (/^[0-9a-f]{32}$/.test(name) &&
        !listed.has(name) &&
        !(await stat(join(imagesDir(o.configDir), name, 'meta.json')).catch(
          () => undefined,
        )))
    if (!leftover) continue
    const st = await stat(join(imagesDir(o.configDir), name)).catch(
      () => undefined,
    )
    if (!st || now - st.mtimeMs < DAY_MS) continue
    await remove(name, 'left by a build that stopped', 0)
  }
  return { removed, failed }
}
