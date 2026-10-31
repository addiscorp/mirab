// macOS guest bases (Apple silicon): `mirab image pull macos` fetches Apple's
// restore image, installs it into a VM disk, and provisions it once, so every
// macOS VM after that is an APFS clone of the base that boots straight into
// mirab's guest agent.
//
//   <config dir>/macos/<version>/        one base: disk.img, hardware-model,
//                                        machine-id, aux.img, base.json
//   <config dir>/macos/ipsw/<file>.ipsw  the restore image while installing
//
// Provisioning is the one step that needs an administrator: a fresh macOS
// boots into Setup Assistant with nobody logged in, so before its first boot
// the base gets `.AppleSetupDone` and the guest agent as a LaunchDaemon, and
// launchd only runs a LaunchDaemon owned by root. The helper and the agent
// come from mirab's own release (<config dir>/vm, checked against image.json
// before they run as root), never from wherever a user dropped a binary.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs'
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import { MIRAB_RELEASE, vmImagePaths } from './image'

export const macosDir = (configDir: string) => join(configDir, 'macos')

const baseSchema = z.object({
  version: z.string(),
  build: z.string(),
  ipsw: z.string(),
  diskGiB: z.number().int(),
  installedAt: z.string(),
  /** sha256 of the guest agent the base was provisioned with. */
  agent: z.string(),
  mirab: z.string(),
})
export type MacosBase = z.infer<typeof baseSchema> & { dir: string }

/** `27.2` before `27.10`, `27.2` before `27.2.1`. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number),
    pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

/** The provisioned bases on this machine, newest first. A directory without
 *  base.json (an install that stopped, or one made by hand) is not a base. */
export function listMacosBases(configDir: string): MacosBase[] {
  const root = macosDir(configDir)
  if (!existsSync(root)) return []
  const out: MacosBase[] = []
  for (const name of readdirSync(root)) {
    if (name.startsWith('.') || name === 'ipsw') continue
    const dir = join(root, name)
    try {
      const parsed = baseSchema.safeParse(
        JSON.parse(readFileSync(join(dir, 'base.json'), 'utf8')),
      )
      if (parsed.success) out.push({ ...parsed.data, dir })
    } catch {
      // not a base
    }
  }
  return out.sort((a, b) => compareVersions(b.version, a.version))
}

/** The base a darwin-arm64 runner uses when isolation.json names none. */
export const newestMacosBase = (configDir: string): string | undefined =>
  listMacosBases(configDir)[0]?.dir

export interface RestoreImage {
  url: string
  version: string
  build: string
  supported: boolean
}

export class MacosPullError extends Error {}

/** How provisioning gets administrator rights: `sudo` in a terminal (so it
 *  works over SSH too), else macOS's own password dialog. */
export type Elevate = (argv: string[], why: string) => Promise<void>

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

export const elevate: Elevate = async (argv, why) => {
  const r = process.stdin.isTTY
    ? spawnSync('sudo', ['--', ...argv], { stdio: 'inherit' })
    : spawnSync(
        'osascript',
        [
          '-e',
          `do shell script ${JSON.stringify(argv.map(sh).join(' '))} with prompt ${JSON.stringify(why)} with administrator privileges`,
        ],
        { stdio: ['ignore', 'inherit', 'pipe'], encoding: 'utf8' },
      )
  if (r.status !== 0)
    throw new MacosPullError(
      `provisioning needs an administrator and did not run${r.stderr ? `: ${String(r.stderr).trim()}` : ''}`,
    )
}

export interface PullOptions {
  configDir: string
  /** A local .ipsw instead of the newest one Apple publishes for this Mac. */
  ipsw?: string
  diskGiB?: number
  /** Keep the restore image after installing (25 GB or so). */
  keepIpsw?: boolean
  log?: (line: string) => void
  elevate?: Elevate
  /** The helper and agent; tests and checkouts point elsewhere. */
  helper?: string
  agent?: string
  /** `<os>-<arch>` of this machine (tests pretend). */
  host?: string
  /** Live progress of the long steps (the CLI draws it as one line on a
   *  terminal); without it, they log a line every few percent. */
  progress?: (p: PullProgress | null) => void
}

/** A long step: `fraction` is 0..1, or absent while it can't say yet (Apple's
 *  installer prepares for a minute or so first). `null` ends the step. */
export interface PullProgress {
  step: string
  fraction?: number
  detail?: string
}

async function sha256(path: string) {
  const h = createHash('sha256')
  await pipeline(
    createReadStream(path),
    new Transform({
      transform(chunk: Buffer, _e, done) {
        h.update(chunk)
        done()
      },
    }),
  )
  return h.digest('hex')
}

/** The published helper and agent, checked against the release record before
 *  they run as root. A hand-built image (no record) is trusted as its builder's. */
async function releaseTools(o: PullOptions) {
  const paths = vmImagePaths(o.configDir)
  const helper = o.helper ?? paths.vz
  const agent = o.agent ?? paths.agent
  for (const [what, path] of [
    ['the mirab-vz helper', helper],
    ['the macOS guest agent', agent],
  ] as const)
    if (!existsSync(path))
      throw new MacosPullError(
        `${what} is missing (${path}): it ships with mirab's VM image, which is fetched on first VM use (\`mirab vm status\`)`,
      )
  const record = existsSync(paths.record)
    ? (() => {
        try {
          return JSON.parse(readFileSync(paths.record, 'utf8'))
        } catch {
          return undefined
        }
      })()
    : undefined
  if (!o.helper && !o.agent && record?.source === 'release') {
    for (const [role, path] of [
      ['vz', helper],
      ['agent', agent],
    ] as const) {
      const want = record.files?.[role]?.sha256
      if (!want)
        throw new MacosPullError(
          `mirab ${record.version}'s VM image has no ${role} file: macOS guests need a newer mirab`,
        )
      if ((await sha256(path)) !== want)
        throw new MacosPullError(
          `refusing to run ${path} as root: it is not the file mirab's release installed (sha256 differs); delete ${paths.dir} and run any VM command to fetch it again`,
        )
    }
  }
  return { helper, agent }
}

function restoreImage(helper: string, ipsw?: string): RestoreImage {
  const r = spawnSync(
    helper,
    ['macos-restore-image', ...(ipsw ? ['--ipsw', ipsw] : [])],
    { encoding: 'utf8' },
  )
  if (r.status !== 0)
    throw new MacosPullError(
      `could not read the macOS restore image: ${(r.stderr || r.stdout).trim()}`,
    )
  return JSON.parse(r.stdout) as RestoreImage
}

const gb = (n: number) => `${(n / 1e9).toFixed(1)} GB`

/** Download to `to`, resuming a `.part` left by a stopped pull. */
async function fetchIpsw(
  url: string,
  to: string,
  log: (l: string) => void,
  progress?: PullOptions['progress'],
) {
  if (existsSync(to)) {
    log(`restore image: already here (${gb(statSync(to).size)})`)
    return
  }
  const part = `${to}.part`
  const have = existsSync(part) ? statSync(part).size : 0
  const res = await fetch(url, {
    headers: have ? { Range: `bytes=${have}-` } : {},
  })
  if (!res.ok || !res.body)
    throw new MacosPullError(`could not fetch ${url}: HTTP ${res.status}`)
  const resumed = res.status === 206
  const start = resumed ? have : 0
  const total = start + Number(res.headers.get('content-length') ?? 0)
  log(`${resumed ? 'resuming' : 'downloading'} ${basename(url)} (${gb(total)})`)
  let got = start,
    shown = -1
  await pipeline(
    Readable.fromWeb(res.body as never),
    new Transform({
      transform(chunk: Buffer, _e, done) {
        got += chunk.length
        if (progress) {
          progress({
            step: 'downloading',
            fraction: total ? got / total : undefined,
            detail: `${gb(got)} / ${gb(total)}`,
          })
          return done(null, chunk)
        }
        const pct = total ? Math.floor((got / total) * 20) * 5 : 0
        if (pct > shown) {
          shown = pct
          log(`  ${gb(got)} / ${gb(total)} (${pct}%)`)
        }
        done(null, chunk)
      },
    }),
    createWriteStream(part, { flags: resumed ? 'a' : 'w', mode: 0o600 }),
  )
  progress?.(null)
  await rename(part, to)
}

function install(
  helper: string,
  ipsw: string,
  dir: string,
  gib: number,
  log: (l: string) => void,
  progress?: PullOptions['progress'],
) {
  return new Promise<void>((resolve, reject) => {
    // Until the installer's first "progress" line: no fraction yet.
    progress?.({ step: 'installing', detail: 'preparing' })
    let fraction: number | undefined
    // Redrawn every second, so the elapsed time moves while Apple's
    // installer is quiet.
    const tick = progress
      ? setInterval(
          () =>
            progress({
              step: 'installing',
              fraction,
              detail: fraction === undefined ? 'preparing' : undefined,
            }),
          1000,
        )
      : undefined
    const p = spawn(
      helper,
      [
        'macos-install',
        '--ipsw',
        ipsw,
        '--dir',
        dir,
        '--disk-gib',
        String(gib),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let err = '',
      shown = -1
    p.stdout.setEncoding('utf8').on('data', (d: string) => {
      for (const line of d.split('\n')) {
        const m = /^progress (\d+)/.exec(line)
        if (m && progress) {
          fraction = Number(m[1]) / 100
          progress({ step: 'installing', fraction })
          continue
        }
        const pct = m ? Math.floor(Number(m[1]) / 10) * 10 : -1
        if (pct > shown) {
          shown = pct
          log(`  installing: ${pct}%`)
        }
      }
    })
    p.stderr.setEncoding('utf8').on('data', (d: string) => (err += d))
    const end = () => {
      if (tick) clearInterval(tick)
      progress?.(null)
    }
    p.on('error', (e) => {
      end()
      reject(e)
    })
    p.on('exit', (code) => {
      end()
      if (code === 0) resolve()
      else reject(new MacosPullError(`installing macOS failed: ${err.trim()}`))
    })
  })
}

/** Fetch, install and provision the newest macOS this Mac runs (or `ipsw`);
 *  a base that is already here is returned as it is. */
export async function pullMacos(o: PullOptions): Promise<MacosBase> {
  if ((o.host ?? `${process.platform}-${process.arch}`) !== 'darwin-arm64')
    throw new MacosPullError('macOS guests need a Mac with Apple silicon')
  const log = o.log ?? (() => {})
  const gib = o.diskGiB ?? 64
  log("checking mirab's helper and macOS guest agent against its release")
  const { helper, agent } = await releaseTools(o)
  log(
    o.ipsw
      ? `reading ${o.ipsw}`
      : 'asking Apple for the newest macOS this Mac runs',
  )
  const image = restoreImage(helper, o.ipsw)
  log(`macOS ${image.version} (${image.build})`)
  if (!image.supported)
    throw new MacosPullError(
      `macOS ${image.version} (${image.build}) does not run in a VM on this Mac`,
    )
  const root = macosDir(o.configDir)
  const have = listMacosBases(o.configDir).find(
    (b) => b.version === image.version && b.build === image.build,
  )
  if (have) {
    log(`macOS ${image.version} (${image.build}) is already here: ${have.dir}`)
    return have
  }

  await mkdir(join(root, 'ipsw'), { recursive: true, mode: 0o700 })
  const ipsw =
    o.ipsw ?? join(root, 'ipsw', basename(new URL(image.url).pathname))
  if (!o.ipsw) await fetchIpsw(image.url, ipsw, log, o.progress)

  const final = join(root, image.version)
  const stage = join(root, `.${image.version}.part`)
  await rm(stage, { recursive: true, force: true })
  await mkdir(stage, { recursive: true, mode: 0o700 })
  try {
    log(
      `installing macOS ${image.version} into a ${gib} GiB disk (about 5 minutes; Apple's installer prepares for a minute before it reports progress)`,
    )
    await install(helper, ipsw, stage, gib, log, o.progress)
    log(
      'provisioning needs an administrator, once for this base. It writes two files into the VM disk (never onto this Mac):',
    )
    log('  /private/var/db/.AppleSetupDone (no Setup Assistant on first boot)')
    log(
      '  /Library/LaunchDaemons/gg.mirab.guest-agent.plist + /usr/local/libexec/mirab-guest-agent (how mirab talks to the VM)',
    )
    await (o.elevate ?? elevate)(
      [helper, 'macos-provision', '--dir', stage, '--agent', agent],
      `mirab is preparing a macOS ${image.version} VM: it writes mirab's guest agent into the VM's disk.`,
    )
    if (!existsSync(join(stage, 'provisioned')))
      throw new MacosPullError('provisioning ran but left no marker')
    const base = {
      version: image.version,
      build: image.build,
      ipsw: o.ipsw ?? image.url,
      diskGiB: gib,
      installedAt: new Date().toISOString(),
      agent: await sha256(agent),
      mirab: MIRAB_RELEASE,
    }
    await writeFile(
      join(stage, 'base.json'),
      JSON.stringify(base, null, 2) + '\n',
    )
    await rm(final, { recursive: true, force: true })
    await rename(stage, final)
    if (!o.ipsw && !o.keepIpsw) await rm(ipsw, { force: true })
    log(`macOS ${image.version} (${image.build}) is ready: ${final}`)
    return { ...base, dir: final }
  } catch (e) {
    await rm(stage, { recursive: true, force: true })
    throw e
  }
}

/** Disk a base takes (its sparse disk.img's allocated blocks). */
export async function baseBytes(dir: string) {
  try {
    return (await stat(join(dir, 'disk.img'))).blocks * 512
  } catch {
    return 0
  }
}
