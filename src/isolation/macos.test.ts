// `mirab image pull macos` with a fake helper (a shell script that answers
// like mirab-vz), a fake Apple CDN (Bun.serve, with Range for resumes) and a
// fake elevate that records what would run as root and runs it unprivileged.
import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { vmImagePaths } from './image'
import {
  compareVersions,
  listMacosBases,
  macosDir,
  newestMacosBase,
  pullMacos,
  type Elevate,
  type PullProgress,
} from './macos'

const IPSW = Buffer.from('restore image bytes '.repeat(50_000))
let served: { range?: string }[] = []
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const range = req.headers.get('range') ?? undefined
    served.push({ range })
    const m = range && /^bytes=(\d+)-$/.exec(range)
    if (m) {
      const from = Number(m[1])
      return new Response(new Uint8Array(IPSW.subarray(from)), {
        status: 206,
        headers: { 'content-length': String(IPSW.length - from) },
      })
    }
    return new Response(new Uint8Array(IPSW), {
      headers: { 'content-length': String(IPSW.length) },
    })
  },
})
afterAll(() => server.stop(true))
const URL_ = `http://127.0.0.1:${server.port}/fixtures/UniversalMac_27.2_26B123_Restore.ipsw`

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')

/** A helper that answers like mirab-vz; `provision` can be told to fail. */
async function fakeTools(dir: string, o: { supported?: boolean } = {}) {
  await mkdir(dir, { recursive: true })
  const helper = join(dir, 'mirab-vz')
  const agent = join(dir, 'agent')
  await writeFile(
    helper,
    `#!/bin/sh
set -eu
case "$1" in
  macos-restore-image)
    if [ "\${2:-}" = --ipsw ]; then url="$3"; else url='${URL_}'; fi
    printf '{"build":"26B123","supported":${o.supported === false ? 'false' : 'true'},"url":"%s","version":"27.2"}\\n' "$url" ;;
  macos-install)
    shift; while [ $# -gt 0 ]; do case "$1" in --ipsw) ipsw=$2;; --dir) d=$2;; esac; shift 2; done
    cp "$ipsw" "$d/disk.img"
    : > "$d/hardware-model"; : > "$d/machine-id"; : > "$d/aux.img"
    echo progress 50; echo progress 100; echo installed ;;
  macos-provision)
    [ -n "\${FAIL_PROVISION:-}" ] && { echo 'mount failed' >&2; exit 1; }
    shift; while [ $# -gt 0 ]; do case "$1" in --dir) d=$2;; --agent) a=$2;; esac; shift 2; done
    cp "$a" "$d/agent-installed"; : > "$d/provisioned" ;;
esac
`,
  )
  await chmod(helper, 0o755)
  await writeFile(agent, 'guest agent bytes')
  return { helper, agent }
}

/** Runs what would need root, unprivileged, and remembers it. */
function fakeElevate() {
  const calls: { argv: string[]; why: string }[] = []
  const elevate: Elevate = async (argv, why) => {
    calls.push({ argv, why })
    const r = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(r.stderr)
  }
  return { elevate, calls }
}

async function configDir() {
  await mkdir(resolve('.tmp'), { recursive: true, mode: 0o700 })
  return mkdtemp(join(resolve('.tmp'), 'macos-'))
}

describe('mirab image pull macos', () => {
  test('fetches, installs, provisions once as administrator, and lists the base', async () => {
    const dir = await configDir()
    const tools = await fakeTools(dir)
    const { elevate, calls } = fakeElevate()
    const lines: string[] = []
    served = []
    const base = await pullMacos({
      configDir: dir,
      ...tools,
      elevate,
      host: 'darwin-arm64',
      log: (l) => lines.push(l),
    })
    const final = join(macosDir(dir), '27.2')
    expect(base).toMatchObject({
      version: '27.2',
      build: '26B123',
      dir: final,
      ipsw: URL_,
      diskGiB: 64,
      agent: sha('guest agent bytes'),
    })
    // Installed from the downloaded restore image; provisioned with the agent.
    expect((await readFile(join(final, 'disk.img'))).equals(IPSW)).toBe(true)
    expect(await readFile(join(final, 'agent-installed'), 'utf8')).toBe(
      'guest agent bytes',
    )
    // Exactly one privileged step, and it is the helper's provision.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.argv).toEqual([
      tools.helper,
      'macos-provision',
      '--dir',
      join(macosDir(dir), '.27.2.part'),
      '--agent',
      tools.agent,
    ])
    expect(calls[0]!.why).toMatch(/macOS 27\.2/)
    // Says what it writes before asking.
    expect(lines.join('\n')).toMatch(/\.AppleSetupDone[\s\S]*LaunchDaemons/)
    // The restore image (25 GB or so) and the stage are gone.
    expect(
      existsSync(
        join(macosDir(dir), 'ipsw', 'UniversalMac_27.2_26B123_Restore.ipsw'),
      ),
    ).toBe(false)
    expect(existsSync(join(macosDir(dir), '.27.2.part'))).toBe(false)
    expect(listMacosBases(dir).map((b) => b.version)).toEqual(['27.2'])
    expect(newestMacosBase(dir)).toBe(final)

    // A second pull finds it: no download, no administrator.
    served = []
    const again = await pullMacos({
      configDir: dir,
      ...tools,
      elevate,
      host: 'darwin-arm64',
    })
    expect(again.dir).toBe(final)
    expect(served).toHaveLength(0)
    expect(calls).toHaveLength(1)
    await rm(dir, { recursive: true, force: true })
  })

  test('with a progress callback, the long steps report through it: preparing first, then how far, then their end', async () => {
    const dir = await configDir()
    const tools = await fakeTools(dir)
    const events: (PullProgress | null)[] = []
    const lines: string[] = []
    await pullMacos({
      configDir: dir,
      ...tools,
      elevate: fakeElevate().elevate,
      host: 'darwin-arm64',
      log: (l) => lines.push(l),
      progress: (p) => events.push(p),
    })
    const steps = (step: string) =>
      events.filter((e) => e?.step === step) as PullProgress[]
    // The download: fractions that only grow, to 1, then the step ends.
    const dl = steps('downloading').map((e) => e.fraction!)
    expect(dl.length).toBeGreaterThan(0)
    expect(dl).toEqual([...dl].sort((a, b) => a - b))
    expect(dl.at(-1)).toBe(1)
    // The install: 'preparing' (no fraction) before the installer says
    // anything, then its own numbers.
    const inst = steps('installing')
    expect(inst[0]).toEqual({ step: 'installing', detail: 'preparing' })
    expect(inst.map((e) => e.fraction).filter((f) => f !== undefined)).toEqual([
      0.5, 1,
    ])
    // Each step ends (null) before the next starts; nothing is left open
    // when the administrator prompt comes.
    expect(events.filter((e) => e === null)).toHaveLength(2)
    expect(events.at(-1)).toBeNull()
    // The percentages go to the live line, not the log.
    expect(lines.some((l) => /installing: \d+%/.test(l))).toBe(false)
    // Every step says what it's doing before it starts.
    expect(lines.join('\n')).toMatch(
      /checking mirab's helper[\s\S]*asking Apple[\s\S]*macOS 27\.2 \(26B123\)[\s\S]*installing macOS 27\.2/,
    )
    await rm(dir, { recursive: true, force: true })
  })

  test('a stopped download resumes where it stopped', async () => {
    const dir = await configDir()
    const tools = await fakeTools(dir)
    const ipsw = join(
      macosDir(dir),
      'ipsw',
      'UniversalMac_27.2_26B123_Restore.ipsw',
    )
    await mkdir(join(macosDir(dir), 'ipsw'), { recursive: true })
    await writeFile(`${ipsw}.part`, IPSW.subarray(0, 300_000))
    served = []
    await pullMacos({
      configDir: dir,
      ...tools,
      elevate: fakeElevate().elevate,
      host: 'darwin-arm64',
      keepIpsw: true,
    })
    expect(served).toEqual([{ range: 'bytes=300000-' }])
    expect((await readFile(ipsw)).equals(IPSW)).toBe(true)
    await rm(dir, { recursive: true, force: true })
  })

  test('a failed provision leaves no base and no half-made directory', async () => {
    const dir = await configDir()
    const tools = await fakeTools(dir)
    process.env.FAIL_PROVISION = '1'
    try {
      await expect(
        pullMacos({
          configDir: dir,
          ...tools,
          elevate: fakeElevate().elevate,
          host: 'darwin-arm64',
        }),
      ).rejects.toThrow(/mount failed/)
    } finally {
      delete process.env.FAIL_PROVISION
    }
    expect(listMacosBases(dir)).toEqual([])
    expect(existsSync(join(macosDir(dir), '27.2'))).toBe(false)
    expect(existsSync(join(macosDir(dir), '.27.2.part'))).toBe(false)
    await rm(dir, { recursive: true, force: true })
  })

  test("refuses to run a helper or agent as root that isn't the release's", async () => {
    const dir = await configDir()
    const paths = vmImagePaths(dir)
    await mkdir(paths.dir, { recursive: true })
    const tools = await fakeTools(join(dir, 'build'))
    await writeFile(paths.vz, await readFile(tools.helper))
    await chmod(paths.vz, 0o755)
    await writeFile(paths.agent, 'guest agent bytes')
    const r = {
      source: 'release',
      version: '0.3.0',
      platform: 'darwin-arm64',
      protocol: 2,
      commit: 'x',
      files: {
        vz: { sha256: sha(await readFile(paths.vz)), size: 0 },
        agent: { sha256: '0'.repeat(64), size: 0 },
      },
    }
    await writeFile(paths.record, JSON.stringify(r))
    const { elevate, calls } = fakeElevate()
    await expect(
      pullMacos({ configDir: dir, elevate, host: 'darwin-arm64' }),
    ).rejects.toThrow(/refusing to run .*mirab-guest-agent-macos as root/)
    expect(calls).toHaveLength(0)

    // The release's own files pass, and are what gets elevated.
    r.files.agent.sha256 = sha('guest agent bytes')
    await writeFile(paths.record, JSON.stringify(r))
    await pullMacos({ configDir: dir, elevate, host: 'darwin-arm64' })
    expect(calls[0]!.argv[0]).toBe(paths.vz)
    expect(calls[0]!.argv.at(-1)).toBe(paths.agent)
    await rm(dir, { recursive: true, force: true })
  })

  test('only on Apple silicon, and only a macOS this Mac can run', async () => {
    const dir = await configDir()
    const tools = await fakeTools(dir)
    await expect(
      pullMacos({ configDir: dir, ...tools, host: 'darwin-x64' }),
    ).rejects.toThrow(/Apple silicon/)
    const unsupported = await fakeTools(join(dir, 'old-mac'), {
      supported: false,
    })
    await expect(
      pullMacos({ configDir: dir, ...unsupported, host: 'darwin-arm64' }),
    ).rejects.toThrow(/does not run in a VM on this Mac/)
    await rm(dir, { recursive: true, force: true })
  })
})

describe('macOS bases on this machine', () => {
  test('newest first; stopped installs, hand-made folders and the ipsw cache are not bases', async () => {
    const dir = await configDir()
    const make = async (name: string, version?: string) => {
      await mkdir(join(macosDir(dir), name), { recursive: true })
      if (version)
        await writeFile(
          join(macosDir(dir), name, 'base.json'),
          JSON.stringify({
            version,
            build: 'b',
            ipsw: 'u',
            diskGiB: 64,
            installedAt: 'now',
            agent: 'a',
            mirab: 'm',
          }),
        )
    }
    await make('27.2', '27.2')
    await make('27.10', '27.10')
    await make('26.4', '26.4')
    await make('.28.0.part', '28.0')
    await make('ipsw')
    await make('by-hand')
    expect(listMacosBases(dir).map((b) => b.version)).toEqual([
      '27.10',
      '27.2',
      '26.4',
    ])
    expect(compareVersions('27.2', '27.2.1')).toBeLessThan(0)
    await rm(dir, { recursive: true, force: true })
  })
})
