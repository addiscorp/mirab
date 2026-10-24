// `mirab dev`: the agent in a project, running in its own VM on this
// machine (docs/architecture.md section 3). The VM has no network of its own;
// its only way out is the station, which lets it reach the manifest's
// `domains` and adds the model key from harar on the host. The person's
// terminal is the agent loop's pty in the guest.
import { randomBytes } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { loadManifest } from './agent/manifest'
import { startVm, type Isolation } from './isolation'
import type { PtyHandle } from './isolation/session'
import { EGRESS_HOST_PORT } from './isolation/vz'
import { guestEnvironment, requireVm } from './spawn-vm'
import { privateSessionsDirectory } from './spawn-sessions'
import type { StationConfig } from './station/config'
import { startEgress } from './station/egress'
import { hararGet } from './station/harar'

/** Where the loop lands in the guest (its tmpfs, never the workspace). */
export const GUEST_LOOP = '/tmp/mirab/loop.js'
export const ANTHROPIC = 'https://api.anthropic.com'

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
  close(): Promise<void>
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
}): Promise<Dev> {
  const project = resolve(o.project)
  // Checked on the host first: a broken agent never boots a VM.
  const { manifest } = await loadManifest(project)
  if (!manifest.model.startsWith('anthropic/'))
    throw new Error(
      `mirab dev talks to anthropic models for now; ${manifest.model} isn't one`,
    )
  const keyPath = o.station.models.anthropic?.key
  if (!keyPath)
    throw new Error(
      'station.json has no models.anthropic.key: the harar secret with the API key',
    )
  const vm = await requireVm(o.configDir, o.log)
  const loop = await guestLoop()
  const org = manifest.name.slice(0, manifest.name.indexOf('.agent.'))
  const zone = `${org}.zone.dev-${randomBytes(6).toString('hex')}`
  const vmDir = await mkdtemp(join(await privateSessionsDirectory(), 'dev-'))
  // No network of its own: the station is the only way out.
  const iso = await startVm({ ...vm, egress: 'block' }, project, vmDir, o.log)
  try {
    await iso.onGuestConnect!(EGRESS_HOST_PORT, (socketPath) =>
      startEgress({
        socketPath,
        zone,
        allow: manifest.domains,
        routes: {
          anthropic: {
            upstream: o.upstream ?? ANTHROPIC,
            header: 'x-api-key',
            paths: ['/v1/messages'],
            credential: () => hararGet(o.station.harar.socket, keyPath),
          },
        },
        auditLog: o.auditLog,
      }),
    )
    await iso.put(GUEST_LOOP, loop, 0o600)
    const pty = await iso.pty!({
      // No auto-install: what the agent runs is in its image (its manifest's packages).
      argv: ['bun', '--no-install', GUEST_LOOP, '/workspace'],
      env: guestEnvironment({}, {}),
      cwd: '/workspace',
      cols: o.cols,
      rows: o.rows,
    })
    return { pty, iso, zone, close: () => iso.close() }
  } catch (e) {
    await iso.close()
    throw e
  }
}

/** `mirab dev` in a terminal: the person's keys to the guest, its output back. */
export async function devInTerminal(
  options: Omit<Parameters<typeof startDev>[0], 'cols' | 'rows'>,
): Promise<number> {
  const out = process.stdout
  const dev = await startDev({
    ...options,
    cols: out.columns || 80,
    rows: out.rows || 24,
  })
  const input = process.stdin
  const raw = input.isTTY
  if (raw) input.setRawMode(true)
  const forward = (data: Buffer) => dev.pty.write(data)
  const resize = () => dev.pty.resize(out.columns || 80, out.rows || 24)
  input.on('data', forward)
  out.on('resize', resize)
  dev.pty.onData((data) => out.write(data))
  try {
    return await new Promise<number>((done) => dev.pty.onExit(done))
  } finally {
    input.off('data', forward)
    out.off('resize', resize)
    if (raw) input.setRawMode(false)
    input.pause()
    await dev.close()
  }
}
