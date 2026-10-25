// `mirab dev`: the agent in a project, running in its own VM on this
// machine (docs/architecture.md section 3). The VM has no network of its own;
// its only way out is the station, which lets it reach the manifest's
// `domains` and adds the model key from harar on the host. The person's
// terminal is the agent loop's pty in the guest.
import { randomBytes } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { MANIFEST_LINE } from './agent/guest'
import { parseManifest, type Manifest } from './agent/manifest'
import { startVm, type Isolation, type VmConfig } from './isolation'
import { agentImage } from './images'
import { liveSync, type LiveSync } from './dev-sync'
import { describeSync, hostManifest, syncBack } from './isolation/sync'
import type { PtyHandle } from './isolation/session'
import { finishVmSync, guestEnvironment, requireVm } from './spawn-vm'
import { privateSessionsDirectory } from './spawn-sessions'
import type { StationConfig } from './station/config'
import type { Upstream } from './station/intercept'
import { vmStation } from './station/vm'
import { anthropicKeyRoute } from './station/routes'

/** Where the loop lands in the guest (its tmpfs, never the workspace). */
export const GUEST_LOOP = '/tmp/mirab/loop.js'

let bundle: Promise<string> | undefined

/** The agent loop and everything it needs, as one file for the guest's Bun. */
export function guestLoop(): Promise<string> {
  return (bundle ??= Bun.build({
    entrypoints: [join(import.meta.dir, 'agent/guest.ts')],
    target: 'bun',
    minify: true,
  }).then(async (built) => {
    if (!built.success || built.outputs.length !== 1)
      throw new Error(
        `the agent loop didn't build: ${built.logs.map(String).join('; ')}`,
      )
    return built.outputs[0].text()
  }))
}

export interface Dev {
  pty: PtyHandle
  iso: Isolation
  /** The zone this VM is, in the station's audit log. */
  zone: string
  /** The person's edits into the VM as they save. */
  live: LiveSync
  close(): Promise<void>
}

/** Reads the manifest the guest printed; the host trusts only what the schema allows. */
export function manifestFromGuest(lines: string[]): Manifest {
  const line = lines.find((l) => l.startsWith(MANIFEST_LINE))
  if (!line)
    throw new Error(
      `the agent didn't load in its VM: ${lines.slice(-5).join(' ').slice(0, 2000)}`,
    )
  let data: unknown
  try {
    data = JSON.parse(line.slice(MANIFEST_LINE.length))
  } catch {
    throw new Error("the VM's manifest isn't JSON")
  }
  return parseManifest(data, 'the agent in its VM')
}

/** The agent's manifest, read in the VM by the bundled loop: the agent's own
 *  files run there, never on the host, which only checks the JSON. */
export async function readManifestIn(iso: Isolation): Promise<Manifest> {
  const lines: string[] = []
  await iso.exec(
    ['bun', '--no-install', GUEST_LOOP, '--manifest', '/workspace'],
    {
      cwd: '/workspace',
      env: guestEnvironment({}, {}),
      timeoutMs: 60_000,
      signal: new AbortController().signal,
      onLine: async (line) => void lines.push(line),
    },
  )
  return manifestFromGuest(lines)
}

/** The manifest of the agent in `project`, read in a VM that boots only for it. */
export async function agentManifest(o: {
  project: string
  configDir: string
  log?: (line: string) => void
}): Promise<{ manifest: Manifest; vm: VmConfig }> {
  const vm = await requireVm(o.configDir, o.log)
  const vmDir = await mkdtemp(
    join(await privateSessionsDirectory(), 'manifest-'),
  )
  const iso = await startVm(
    { ...vm, egress: 'block' },
    resolve(o.project),
    vmDir,
    o.log,
  )
  try {
    await iso.put(GUEST_LOOP, await guestLoop(), 0o600)
    return { manifest: await readManifestIn(iso), vm }
  } finally {
    await iso.close()
  }
}

/** `<org>.zone.dev-<random>`, in the agent's org. */
export function devZone(agentName: string): string {
  const org = /^(.+)\.agent\.[^.]+$/.exec(agentName)?.[1]
  if (!org) throw new Error(`${agentName} isn't an agent name`)
  return `${org}.zone.dev-${randomBytes(6).toString('hex')}`
}

export async function startDev(o: {
  project: string
  configDir: string
  station: StationConfig
  cols: number
  rows: number
  /** Where the egress decisions go (JSON lines). */
  auditLog: string
  log?: (line: string) => void
  /** Where the model route goes; tests point it at a stand-in. */
  upstream?: string
  /** Where the hosts the station opens are; tests point them at a stand-in. */
  opened?: (host: string) => Promise<Upstream>
}): Promise<Dev> {
  const project = resolve(o.project)
  const anthropic = anthropicKeyRoute(o.station, o.upstream)
  if (!anthropic)
    throw new Error(
      'station.json has no models.anthropic.key: the harar secret with the API key',
    )
  const vm = await requireVm(o.configDir, o.log)
  const loop = await guestLoop()
  let vmDir = ''
  const boot = async (rootfs: string) => {
    vmDir = await mkdtemp(join(await privateSessionsDirectory(), 'dev-'))
    // No network of its own: the station is the only way out. The VM works on
    // a clone of the project; nothing it writes comes back.
    const vmIso = await startVm(
      { ...vm, rootfs, egress: 'block' },
      project,
      vmDir,
      o.log,
    )
    try {
      await vmIso.put(GUEST_LOOP, loop, 0o600)
    } catch (e) {
      await vmIso.close()
      throw e
    }
    return vmIso
  }
  // What the VM starts from: the baseline live sync and sync-back compare against.
  const baseline = await hostManifest(project)
  let iso = await boot(vm.rootfs)
  let closeStation = async () => {}
  try {
    // The agent's own files run in the VM, never here.
    const manifest = await readManifestIn(iso)
    if (!manifest.model.startsWith('anthropic/'))
      throw new Error(
        `mirab dev talks to anthropic models for now; ${manifest.model} isn't one`,
      )
    // An agent with packages runs on its own image: cached, or built now.
    if (manifest.packages.length) {
      await iso.close()
      const rootfs = await agentImage({
        configDir: o.configDir,
        vm,
        packages: manifest.packages,
        log: o.log,
      })
      iso = await boot(rootfs)
    }
    const zone = devZone(manifest.name)
    const station = await vmStation({
      project,
      station: o.station,
      configDir: o.configDir,
      zone,
      auditLog: o.auditLog,
      routes: { anthropic },
      allow: manifest.domains,
      agent: manifest.name,
      upstream: o.opened,
    })
    for (const note of station.notes) o.log?.(note)
    await station.attach(iso)
    closeStation = () => station.close()
    const pty = await iso.pty!({
      // No auto-install: what the agent runs is in its image (its manifest's packages).
      argv: ['bun', '--no-install', GUEST_LOOP, '/workspace'],
      env: { ...guestEnvironment({}, {}), ...station.env },
      cwd: '/workspace',
      cols: o.cols,
      rows: o.rows,
    })
    const exited = new Promise<void>((r) => pty.onExit(() => r()))
    const live = liveSync({ project, iso, baseline, log: o.log })
    const close = async () => {
      // The agent stops first, so what comes back is what it finished; a
      // push under way ends before sync-back starts.
      try {
        pty.close()
      } catch {}
      await Promise.race([exited, Bun.sleep(5_000)])
      await live.stop()
      const conflictDir = join(
        await privateSessionsDirectory(),
        `${zone}.conflicts`,
      )
      // What the agent changed comes back; where the person changed the same
      // path, theirs stays and the agent's is saved aside. Anything that
      // couldn't come back keeps the VM's disk for recovery.
      try {
        const synced = await finishVmSync(
          () =>
            syncBack({
              root: project,
              guestRoot: '/workspace',
              files: iso.files!,
              baseline,
              conflictDir,
            }),
          iso,
          vmDir,
          (line) => o.log?.(line),
        )
        o.log?.(`back from the VM: ${describeSync(synced)}`)
      } catch (e) {
        o.log?.(
          `the agent's changes couldn't all come back: ${(e as Error).message}`,
        )
      }
      await closeStation()
    }
    return { pty, iso, zone, close, live }
  } catch (e) {
    await closeStation()
    await iso.close().catch(() => {})
    throw e
  }
}

/** Handled while mirab dev runs: Ctrl-C before the terminal is raw (the VM is
 *  still starting), and being told to stop. The VM is closed either way. */
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

/** Ctrl-]: leaves mirab dev from the host, whatever the guest is doing. */
export const ESCAPE = 0x1d

/** `mirab dev` in a terminal: the person's keys to the guest, its output back. */
export async function devInTerminal(
  options: Omit<Parameters<typeof startDev>[0], 'cols' | 'rows'>,
): Promise<number> {
  const out = process.stdout
  const input = process.stdin
  const raw = input.isTTY
  let dev: Dev | undefined
  let leave: (code: number) => void = () => {}
  const left = new Promise<number>((r) => (leave = r))
  const forward = (data: Buffer) =>
    data.includes(ESCAPE) ? leave(130) : dev?.pty.write(data)
  const resize = () => dev?.pty.resize(out.columns || 80, out.rows || 24)
  const onSignal = () => leave(143)
  const ended = () => dev?.pty.write('\x04')
  for (const signal of SIGNALS) process.on(signal, onSignal)
  try {
    dev = await startDev({
      ...options,
      cols: out.columns || 80,
      rows: out.rows || 24,
    })
    options.log?.('Ctrl-D ends the chat; Ctrl-] leaves at once.')
    dev.pty.onData((data) => out.write(data))
    dev.pty.onExit(leave)
    if (raw) input.setRawMode(true)
    input.on('data', forward)
    // Input that ends (not a terminal) ends the chat as Ctrl-D would.
    input.on('end', ended)
    out.on('resize', resize)
    return await left
  } finally {
    input.off('data', forward)
    input.off('end', ended)
    out.off('resize', resize)
    for (const signal of SIGNALS) process.off(signal, onSignal)
    if (raw) input.setRawMode(false)
    input.pause()
    await dev?.close()
  }
}
