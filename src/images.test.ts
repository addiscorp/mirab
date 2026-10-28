import { expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { defineAgent } from './agent/define'
import {
  baseId,
  cachedImage,
  keep,
  type ImageMeta,
  imageKey,
  imagesDir,
  listImages,
  pruneImages,
  recipeKey,
  upgradesIn,
} from './images'

test("an image's key is its base and its package list, order and repeats aside", () => {
  const a = imageKey('base-1', ['jq', 'git', 'jq'])
  expect(imageKey('base-1', ['git', 'jq'])).toBe(a)
  expect(imageKey('base-2', ['git', 'jq'])).not.toBe(a)
  expect(imageKey('base-1', ['git'])).not.toBe(a)
  expect(a).toMatch(/^[0-9a-f]{32}$/)
})

test('a recipe key ignores object key order and changes with any value', () => {
  const a = recipeKey('base', {
    tools: { rust: '1.91.0', node: '24.21.0' },
    diskGiB: 30,
  })
  const b = recipeKey('base', {
    diskGiB: 30,
    tools: { node: '24.21.0', rust: '1.91.0' },
  })
  expect(a).toBe(b)
  expect(
    recipeKey('base', {
      diskGiB: 30,
      tools: { node: '24.21.1', rust: '1.91.0' },
    }),
  ).not.toBe(a)
  expect(
    recipeKey('other', {
      diskGiB: 30,
      tools: { node: '24.21.0', rust: '1.91.0' },
    }),
  ).not.toBe(a)
})

test("a dry-run upgrade's Inst lines are the packages it would upgrade", () => {
  const lines = [
    'Reading package lists...',
    'The following packages will be upgraded:',
    '  libc6 openssl',
    '2 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.',
    'Inst libc6 [2.39-0ubuntu8.9] (2.39-0ubuntu8.10 Ubuntu:24.04/noble-updates [amd64])',
    'Inst openssl [3.0.13-0ubuntu3.5] (3.0.13-0ubuntu3.6 Ubuntu:24.04/noble-security [amd64])',
    'Conf libc6 (2.39-0ubuntu8.10 Ubuntu:24.04/noble-updates [amd64])',
  ]
  expect(upgradesIn(lines)).toEqual(['libc6', 'openssl'])
  expect(upgradesIn(['0 upgraded, 0 newly installed'])).toEqual([])
})

test("package names apt can't read as anything but a package", () => {
  const agent = (packages: string[]) => () =>
    defineAgent({ name: 'gg.addis.agent.ops', model: 'anthropic/x', packages })
  expect(agent(['ripgrep', 'g++', 'libc6-dev', 'python3.12'])).not.toThrow()
  for (const bad of ['bash-', '-o', 'APT::Get', 'jq=1.7', 'jq/noble', 'a b'])
    expect(agent([bad])).toThrow('package')
})

const meta = (upgraded: string[]): ImageMeta => ({
  key: 'k',
  packages: ['jq'],
  base: 'b',
  builtAt: 't',
  updatedAt: 't',
  upgraded,
})

/** A VM that only pretends: close({ keepRoot }) writes `disk` there. */
function fakeVm(disk: string, fail = false) {
  const ran: string[][] = []
  return {
    ran,
    exec: async (argv: string[]) => (ran.push(argv), 0),
    close: async (options?: { keepRoot?: string }) => {
      if (options?.keepRoot) await writeFile(options.keepRoot, disk)
      if (fail) throw new Error('stopped badly')
    },
  }
}

test('keeping a disk replaces the image in one step and keeps the one before', async () => {
  await mkdir(resolve('.tmp'), { recursive: true })
  const dir = await mkdtemp(join(resolve('.tmp'), 'keep-'))
  try {
    await writeFile(join(dir, 'rootfs.ext4'), 'old')
    const vm = fakeVm('new')
    await keep(vm as any, dir, meta(['zlib1g']))
    expect(await readFile(join(dir, 'rootfs.ext4'), 'utf8')).toBe('new')
    expect(await readFile(join(dir, 'previous.rootfs.ext4'), 'utf8')).toBe(
      'old',
    )
    expect(
      JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')).upgraded,
    ).toEqual(['zlib1g'])
    // The build's proxy setting is gone before the disk is kept.
    expect(vm.ran[0].join(' ')).toContain(
      'rm -f /etc/apt/apt.conf.d/90mirab-station',
    )
    // A VM that stops badly leaves the image as it was, and no partial file.
    await expect(
      keep(fakeVm('broken', true) as any, dir, meta([])),
    ).rejects.toThrow('stopped badly')
    expect(await readFile(join(dir, 'rootfs.ext4'), 'utf8')).toBe('new')
    const { readdirSync } = await import('node:fs')
    expect(readdirSync(dir).sort()).toEqual([
      'meta.json',
      'previous.rootfs.ext4',
      'rootfs.ext4',
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a rebuildable image keeps no previous copy', async () => {
  await mkdir(resolve('.tmp'), { recursive: true })
  const dir = await mkdtemp(join(resolve('.tmp'), 'keep-'))
  try {
    await writeFile(join(dir, 'rootfs.ext4'), 'old')
    await keep(fakeVm('new') as any, dir, { key: 'k' }, { previous: false })
    expect(await readFile(join(dir, 'rootfs.ext4'), 'utf8')).toBe('new')
    const { readdirSync } = await import('node:fs')
    expect(readdirSync(dir).sort()).toEqual(['meta.json', 'rootfs.ext4'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a base changed in place, same size and time, is a new base', async () => {
  await mkdir(resolve('.tmp'), { recursive: true })
  const dir = await mkdtemp(join(resolve('.tmp'), 'base-'))
  try {
    const file = join(dir, 'rootfs.ext4')
    await writeFile(file, 'aaaa')
    const { utimes } = await import('node:fs/promises')
    await utimes(file, 1000, 1000)
    const first = await baseId(file)
    await writeFile(file, 'bbbb')
    await utimes(file, 1000, 1000)
    expect(await baseId(file)).not.toBe(first)
    // And a cached image built on another base is a miss.
    const img = join(dir, 'images', 'k')
    await mkdir(img, { recursive: true })
    await writeFile(join(img, 'rootfs.ext4'), 'x')
    await writeFile(
      join(img, 'meta.json'),
      JSON.stringify({ ...meta([]), base: first }),
    )
    expect(await cachedImage(dir, 'k', first)).toBeDefined()
    expect(await cachedImage(dir, 'k', await baseId(file))).toBeUndefined()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('prune removes images on an older base, unused ones and stale scratch, and nothing else', async () => {
  mkdirSync(resolve('.tmp'), { recursive: true })
  const configDir = mkdtempSync(join(resolve('.tmp'), 'prune-'))
  const now = new Date('2026-10-25T12:00:00Z')
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000)
  const image = (key: string, base: string, used: Date) => {
    const dir = join(imagesDir(configDir), key)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'rootfs.ext4'), Buffer.alloc(8192, 1))
    writeFileSync(
      join(dir, 'meta.json'),
      JSON.stringify({
        key,
        packages: ['jq'],
        base,
        builtAt: '',
        updatedAt: '',
        upgraded: [],
      }),
    )
    utimesSync(join(dir, 'meta.json'), used, used)
    return dir
  }
  try {
    const fresh = image('a'.repeat(32), 'base-now', daysAgo(1))
    const idle = image('b'.repeat(32), 'base-now', daysAgo(40))
    const old = image('c'.repeat(32), 'base-before', daysAgo(2))
    const stale = join(imagesDir(configDir), '.vm-stale')
    const building = join(imagesDir(configDir), '.vm-now')
    mkdirSync(stale)
    mkdirSync(building)
    utimesSync(stale, daysAgo(2), daysAgo(2))
    utimesSync(building, now, now)
    // Not an image: never touched.
    mkdirSync(join(imagesDir(configDir), 'notes'))
    // A first build that stopped before its meta.json, and one under way now.
    const stopped = join(imagesDir(configDir), 'd'.repeat(32))
    const underWay = join(imagesDir(configDir), 'e'.repeat(32))
    mkdirSync(stopped)
    mkdirSync(underWay)
    utimesSync(stopped, daysAgo(3), daysAgo(3))
    utimesSync(underWay, now, now)
    // Just found in the cache by a mirab dev about to boot it, even on an old base.
    const justUsed = image(
      'f'.repeat(32),
      'base-before',
      new Date(now.getTime() - 60_000),
    )
    expect(
      (await listImages(configDir, 'base-now')).map((i) => [
        i.key[0],
        i.current,
      ]),
    ).toEqual([
      ['f', false],
      ['a', true],
      ['c', false],
      ['b', true],
    ])
    const dry = await pruneImages({
      configDir,
      currentBase: 'base-now',
      days: 30,
      dryRun: true,
      now,
    })
    expect(dry.removed.map((r) => [r.key[0], r.why])).toEqual([
      ['c', 'built on an older base'],
      ['b', 'unused for 40 days'],
      ['.', 'left by a build that stopped'],
      ['d', 'left by a build that stopped'],
    ])
    expect(dry.failed).toEqual([])
    expect(existsSync(old) && existsSync(idle) && existsSync(stale)).toBe(true)
    await pruneImages({ configDir, currentBase: 'base-now', days: 30, now })
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(building)).toBe(true)
    expect(existsSync(join(imagesDir(configDir), 'notes'))).toBe(true)
    expect(existsSync(old) || existsSync(idle) || existsSync(stale)).toBe(false)
    expect(existsSync(stopped)).toBe(false)
    expect(existsSync(underWay) && existsSync(justUsed)).toBe(true)
    // Zero days would take everything: refused.
    await expect(
      pruneImages({ configDir, currentBase: 'base-now', days: 0, now }),
    ).rejects.toThrow('at least 1')
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
})
