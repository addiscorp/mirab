// First VM use fetches the published guest image from the release bucket.
// A fake bucket (Bun.serve) holds a release laid out exactly as the release
// workflow uploads it, with the manifest written by the same function.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { promoteVmManifest, writeVmManifest } from '../../scripts/vm-release'
import {
  ensureVmImage,
  MIRAB_RELEASE,
  MIRAB_VERSION,
  releaseImageInstalled,
  VM_PLATFORMS,
  vmImagePaths,
  vmPlatform,
  type VmPlatform,
  type VmRole,
} from './image'
import {
  assertCanIsolate,
  describe as describeIsolation,
  prepareVm,
  resolveForHost,
  type HostConfig,
  type Probes,
} from './index'
import { GUEST_PROTOCOL } from './session'

const platform: VmPlatform = vmPlatform() ?? 'linux-x64'
const roles = VM_PLATFORMS[platform] as Record<string, string>
const contents: Record<string, Buffer> = Object.fromEntries(
  Object.keys(roles).map((role) => [
    role,
    Buffer.from(`${role} bytes for ${platform} `.repeat(40_000)),
  ]),
)

let root: string
/** Releases on the fake bucket, by tag; each is `<tag>/vm/...`. */
const releases = new Map<string, Map<string, Buffer>>()
let requests: string[] = []
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname.slice(1)
    requests.push(path)
    const [tag, ...rest] = path.split('/')
    const body = releases.get(tag!)?.get(rest.join('/'))
    return body
      ? new Response(new Blob([new Uint8Array(body)]))
      : new Response('no', { status: 404 })
  },
})
const base = `http://127.0.0.1:${server.port}`
const offline = 'http://127.0.0.1:9' // discard port: connection refused

/** Lay a release out like the workflow does, then let the test tamper with it. */
async function publish(
  tag: string,
  tamper: (dir: string) => Promise<void> = async () => {},
  manifest: { version?: string } = {},
) {
  const dir = join(root, 'bucket', tag)
  await mkdir(join(dir, platform), { recursive: true })
  for (const [role, name] of Object.entries(roles))
    await writeFile(
      join(dir, platform, `${name}.gz`),
      gzipSync(contents[role]!),
    )
  await writeVmManifest(dir, { commit: 'abc123', ...manifest })
  await tamper(dir)
  await serve(tag, dir)
}

/** Put `<dir>` (manifest.json, <platform>/*.gz) on the fake bucket as `<tag>/vm/`. */
async function serve(tag: string, dir: string) {
  const files = new Map<string, Buffer>()
  files.set('vm/manifest.json', await readFile(join(dir, 'manifest.json')))
  for (const name of Object.values(roles))
    files.set(
      `vm/${platform}/${name}.gz`,
      await readFile(join(dir, platform, `${name}.gz`)),
    )
  releases.set(tag, files)
}

const configDir = async () => {
  await mkdir(join(root, 'config'), { recursive: true })
  return mkdtemp(join(root, 'config', 'c-'))
}

beforeAll(async () => {
  await mkdir(resolve('.tmp'), { recursive: true })
  root = await mkdtemp(resolve('.tmp/vm-image-'))
})
afterAll(() => server.stop(true))

describe('published VM image', () => {
  test('a release from before macOS guests (no darwin-arm64 agent) still installs and runs Linux VMs', async () => {
    const tag = `${MIRAB_RELEASE}-noagent`
    const dir = join(root, 'bucket', tag)
    const arm = VM_PLATFORMS['darwin-arm64'] as Record<string, string>
    await mkdir(join(dir, 'darwin-arm64'), { recursive: true })
    const bytes = (role: string) =>
      Buffer.from(`${role} arm bytes `.repeat(1000))
    for (const [role, name] of Object.entries(arm))
      await writeFile(
        join(dir, 'darwin-arm64', `${name}.gz`),
        gzipSync(bytes(role)),
      )
    await writeVmManifest(dir, { version: tag, commit: 'old' })
    // What 0.2.0 published: the same image, without the agent.
    const manifest = JSON.parse(
      await readFile(join(dir, 'manifest.json'), 'utf8'),
    )
    delete manifest.platforms['darwin-arm64'].agent
    const files = new Map<string, Buffer>([
      ['vm/manifest.json', Buffer.from(JSON.stringify(manifest))],
    ])
    for (const [role, name] of Object.entries(arm))
      if (role !== 'agent')
        files.set(
          `vm/darwin-arm64/${name}.gz`,
          await readFile(join(dir, 'darwin-arm64', `${name}.gz`)),
        )
    releases.set(tag, files)
    const config = await configDir()
    expect(
      await ensureVmImage({
        configDir: config,
        base,
        platform: 'darwin-arm64',
        version: tag,
      }),
    ).toBe('downloaded')
    expect(releaseImageInstalled(config, tag, 'darwin-arm64')).toBe(true)
    expect(existsSync(vmImagePaths(config).agent)).toBe(false)
    expect((await readFile(vmImagePaths(config).vz)).equals(bytes('vz'))).toBe(
      true,
    )
    // Installed: the next use stays offline.
    expect(
      await ensureVmImage({
        configDir: config,
        base: offline,
        platform: 'darwin-arm64',
        version: tag,
      }),
    ).toBe('installed')
  })

  test('first use downloads, verifies and installs it; later uses stay offline', async () => {
    await publish(MIRAB_RELEASE)
    const dir = await configDir()
    const lines: string[] = []
    requests = []
    expect(
      await ensureVmImage({
        configDir: dir,
        base,
        platform,
        log: (l) => lines.push(l),
      }),
    ).toBe('downloaded')
    const paths = vmImagePaths(dir)
    for (const role of Object.keys(roles))
      expect(
        (await readFile(paths[role as VmRole])).equals(contents[role]!),
      ).toBe(true)
    expect(requests[0]).toBe(`${MIRAB_RELEASE}/vm/manifest.json`)
    expect(lines.join('\n')).toMatch(/downloading the VM image .*%/s)
    const record = JSON.parse(await readFile(paths.record, 'utf8'))
    expect(record).toMatchObject({
      source: 'release',
      version: MIRAB_VERSION,
      platform,
      protocol: GUEST_PROTOCOL,
    })
    // Cached: no request at all, even with the bucket unreachable.
    requests = []
    expect(
      await ensureVmImage({ configDir: dir, base: offline, platform }),
    ).toBe('installed')
    expect(requests).toEqual([])
  })

  test('works offline when cached: --vm gets the installed image with no network', async () => {
    await publish(MIRAB_RELEASE)
    const dir = await configDir()
    await ensureVmImage({ configDir: dir, base, platform })
    const { host, vmUnavailable } = await prepareVm(dir, {
      want: true,
      base: offline,
      platform,
      backendReady: () => true,
    })
    expect(vmUnavailable).toBeUndefined()
    expect(host.vm).toMatchObject({
      kernel: vmImagePaths(dir).kernel,
      rootfs: vmImagePaths(dir).rootfs,
    })
    if (platform === 'darwin-arm64')
      expect(host.vm!.vz).toBe(vmImagePaths(dir).vz)
  })

  test('a file whose sha256 is not the manifest one is refused and nothing is installed', async () => {
    // Same unpacked bytes, different gzip stream: only the published sha256 can tell.
    await publish(MIRAB_RELEASE, async (dir) => {
      const name = roles.rootfs
      await writeFile(
        join(dir, platform, `${name}.gz`),
        gzipSync(contents.rootfs!, { level: 1 }),
      )
    })
    const dir = await configDir()
    await expect(
      ensureVmImage({ configDir: dir, base, platform }),
    ).rejects.toThrow(/refusing .*rootfs\.ext4\.gz: sha256/)
    expect(existsSync(vmImagePaths(dir).rootfs)).toBe(false)
    expect(existsSync(vmImagePaths(dir).record)).toBe(false)
  })

  test('different unpacked bytes are refused too (the gunzipped file is checked as well)', async () => {
    await publish(MIRAB_RELEASE, async (dir) => {
      const m = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
      m.platforms[platform].kernel.unpacked.sha256 = '0'.repeat(64)
      await writeFile(join(dir, 'manifest.json'), JSON.stringify(m))
    })
    const dir = await configDir()
    await expect(
      ensureVmImage({ configDir: dir, base, platform }),
    ).rejects.toThrow(/refusing .*unpacked sha256/)
    expect(existsSync(vmImagePaths(dir).kernel)).toBe(false)
  })

  test('a manifest for another mirab version is refused', async () => {
    await publish(MIRAB_RELEASE, undefined, { version: '0.0.1' })
    const dir = await configDir()
    await expect(
      ensureVmImage({ configDir: dir, base, platform }),
    ).rejects.toThrow(/is for mirab 0\.0\.1, this is mirab/)
    expect(existsSync(vmImagePaths(dir).record)).toBe(false)
  })

  test('a manifest for another guest protocol is refused', async () => {
    await publish(MIRAB_RELEASE, async (dir) => {
      const m = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
      m.protocol = GUEST_PROTOCOL + 1
      await writeFile(join(dir, 'manifest.json'), JSON.stringify(m))
    })
    const dir = await configDir()
    await expect(
      ensureVmImage({ configDir: dir, base, platform }),
    ).rejects.toThrow(/speaks protocol \d+, this mirab speaks/)
  })

  test('an installed image for an older mirab is replaced by this version', async () => {
    await publish('0.0.1', undefined, { version: '0.0.1' })
    await publish(MIRAB_RELEASE)
    const dir = await configDir()
    await ensureVmImage({ configDir: dir, base, platform, version: '0.0.1' })
    expect(await ensureVmImage({ configDir: dir, base, platform })).toBe(
      'downloaded',
    )
  })

  test('a promoted release carries the canary image, named for the stable version', async () => {
    const canary = '9.9.9-canary-abc1234',
      stable = '9.9.9'
    await publish(canary, undefined, { version: canary })
    // promote.yml: the canary's vm/ copied to the stable directory, its
    // manifest rewritten for the stable release.
    const from = join(root, 'bucket', canary),
      to = join(root, 'bucket', stable)
    await cp(from, to, { recursive: true })
    const promoted = await promoteVmManifest(to, stable)
    await serve(stable, to)
    const before = JSON.parse(
      await readFile(join(from, 'manifest.json'), 'utf8'),
    )
    expect(promoted).toEqual({ ...before, version: stable })
    // A mirab (or a consumer following latest.json) at the stable version
    // installs it; the canary's own copy still names the canary.
    const config = await configDir()
    expect(
      await ensureVmImage({
        configDir: config,
        base,
        platform,
        version: stable,
      }),
    ).toBe('downloaded')
    expect(releaseImageInstalled(config, stable, platform)).toBe(true)
    expect(
      (await readFile(vmImagePaths(config).kernel)).equals(contents.kernel!),
    ).toBe(true)
    expect(before.version).toBe(canary)
  })

  test('promotion refuses files that are not the bytes the canary recorded', async () => {
    const canary = '9.9.8-canary-abc1234'
    await publish(canary, undefined, { version: canary })
    const to = join(root, 'bucket', '9.9.8')
    await cp(join(root, 'bucket', canary), to, { recursive: true })
    await writeFile(
      join(to, platform, `${roles.rootfs}.gz`),
      gzipSync(contents.rootfs!, { level: 1 }),
    )
    await expect(promoteVmManifest(to, '9.9.8')).rejects.toThrow(
      /rootfs\.ext4\.gz is not the file the canary recorded/,
    )
    // The canary's manifest is left as it was.
    const left = JSON.parse(await readFile(join(to, 'manifest.json'), 'utf8'))
    expect(left.version).toBe(canary)
  })

  test('a hand-built image (bun run vm:image) is never overwritten', async () => {
    const dir = await configDir()
    await mkdir(join(dir, 'vm'), { recursive: true })
    await writeFile(vmImagePaths(dir).record, '{"protocol":2,"commit":"x"}')
    requests = []
    expect(await ensureVmImage({ configDir: dir, base, platform })).toBe(
      'local',
    )
    expect(requests).toEqual([])
  })
})

describe('no image can be fetched', () => {
  const containerHost: HostConfig = {
    container: {
      engine: 'docker',
      image: 'ubuntu:24.04',
      agent: '/a',
      memory: '2g',
      cpus: '2',
      pids: 512,
      egress: 'auto',
    },
  }
  const machine = (oci: boolean): Probes => ({
    platform: 'linux',
    vm: () => false,
    oci: () => oci,
    colima: () => ({ running: false, reason: 'off', fix: 'colima start' }),
    hostUser: () => ({ ok: false, reason: 'no', fix: 'no' }),
  })

  test('offline with nothing cached: a clear error with the fallback', async () => {
    const dir = await configDir()
    const { host, vmUnavailable } = await prepareVm(dir, {
      want: true,
      base: offline,
      platform,
      backendReady: () => true,
    })
    expect(host.vm).toBeUndefined()
    expect(vmUnavailable).toMatch(
      /could not fetch the VM image for mirab .* connect and retry, build the image yourself \(docs\/VM\.md\), or use --isolation container\|host/,
    )
  })

  test('an embedding package can name the release whose image to use', async () => {
    const dir = await configDir()
    const asked: string[] = []
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        asked.push(new URL(req.url).pathname)
        return new Response('no', { status: 404 })
      },
    })
    try {
      const { vmUnavailable } = await prepareVm(dir, {
        want: true,
        base: `http://localhost:${server.port}`,
        version: '9.9.9-canary-abc1234',
        platform,
        backendReady: () => true,
      })
      expect(asked).toEqual(['/9.9.9-canary-abc1234/vm/manifest.json'])
      expect(vmUnavailable).toContain('mirab 9.9.9-canary-abc1234')
    } finally {
      server.stop(true)
    }
  })

  test('--isolation vm falls to the next tier, and says so', async () => {
    const dir = await configDir()
    const { vmUnavailable } = await prepareVm(dir, {
      want: true,
      base: offline,
      platform,
      backendReady: () => true,
    })
    const r = resolveForHost(
      containerHost,
      { flag: 'vm' },
      machine(true),
      vmUnavailable,
    )
    expect(r).toMatchObject({ level: 'container', source: 'flag' })
    expect(describeIsolation(r, 'oci')).toMatch(
      /isolation: container \(oci\), requested by flag \(vm image unavailable, fell back to container: could not fetch/,
    )
    expect(
      assertCanIsolate(containerHost, 'vm', machine(true), vmUnavailable),
    ).toMatchObject({ level: 'container' })
  })

  test('the fallback never reaches none, and keeps the floor', () => {
    expect(() =>
      resolveForHost({}, { flag: 'vm' }, machine(false), 'offline'),
    ).toThrow(/isolation "vm" is unavailable: offline; and no other tier/)
    expect(() =>
      resolveForHost(
        { ...containerHost, floor: 'vm' },
        { flag: 'vm' },
        machine(true),
        'offline',
      ),
    ).toThrow(/no other tier/)
  })

  test('without a fetch failure, an unavailable vm is still refused', () => {
    expect(() =>
      resolveForHost(containerHost, { flag: 'vm' }, machine(true)),
    ).toThrow(/isolation "vm" \(from flag\) is not available/)
  })
})
