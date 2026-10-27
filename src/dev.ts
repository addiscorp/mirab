// `mirab dev`: the agent in a project, running in its own VM on this
// machine (docs/architecture.md section 3). The VM has no network of its own;
// its only way out is the station, which lets it reach the manifest's
// `domains` and adds the model key from harar on the host. The chat is a
// channel the station hosts (src/channel): the terminal is one client of it,
// the agent loop in the guest another.
import { randomBytes } from 'node:crypto'
import { userInfo } from 'node:os'
import { clearLine, createInterface, cursorTo } from 'node:readline'
import { mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { MANIFEST_LINE } from './agent/guest'
import { bridgeAgent } from './channel/bridge'
import { projectAgent } from './station/escalations'
import { printable } from './channel/wire'
import {
  openChannel,
  type LocalChannel,
  type Member,
  type Message,
} from './channel/local'
import { withinApproval } from './agent/approved'
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
  /** The chat: a channel the station hosts, between the person and the agent. */
  channel: LocalChannel
  /** The person's and the agent's member names. */
  person: string
  agent: string
  /** Says `text` in the channel as the person. */
  say(text: string): Message
  close(): Promise<void>
}

/** The person at this terminal, as a channel member: `station.json`'s
 *  `human`, or this login in the agent's org, which nothing has vouched for. */
export function personMember(
  station: StationConfig,
  org: string,
  login = userInfo().username,
): Member {
  if (station.human) return { name: station.human, can: 'speak' }
  const local =
    login
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .slice(0, 63)
      .replace(/^-+|-+$/g, '') || 'person'
  return { name: `${org}.human.${local}`, can: 'speak', unverified: true }
}

/** Reads the manifest the guest printed; the host trusts only what the schema allows. */
export function manifestFromGuest(lines: string[]): Manifest {
  const line = lines.find((l) => l.startsWith(MANIFEST_LINE))
  if (!line)
    throw new Error(
      `the agent didn't load in its VM: ${printable(lines.slice(-5).join(' ').slice(0, 2000))}`,
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
    return {
      manifest: withinApproval(
        o.configDir,
        resolve(o.project),
        await readManifestIn(iso),
        o.log,
      ),
      vm,
    }
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
    // As the agent's code says it now, within what the person approved.
    const manifest = withinApproval(
      o.configDir,
      project,
      await readManifestIn(iso),
      o.log,
    )
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
    const org = manifest.name.replace(/\.agent\.[^.]+$/, '')
    const person = personMember(o.station, org)
    const channel = openChannel({
      dir: join(await privateSessionsDirectory(), 'channels'),
      org,
      members: [person, { name: manifest.name, can: 'speak' }],
    })
    const station = await vmStation({
      project,
      station: o.station,
      configDir: o.configDir,
      zone,
      auditLog: o.auditLog,
      routes: { anthropic },
      allow: manifest.domains,
      // Whose grants (secrets, hosts asked for): the project folder on this
      // machine, as spawn --vm has it. Never the manifest's name, which the
      // agent's own code says in the VM: a cloned repo could claim a name the
      // person trusted.
      agent: projectAgent(project),
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
    const unbridge = bridgeAgent({
      channel,
      agent: manifest.name,
      pty,
      log: o.log,
    })
    const live = liveSync({ project, iso, baseline, log: o.log })
    const close = async () => {
      // The agent stops first, so what comes back is what it finished; a
      // push under way ends before sync-back starts.
      try {
        pty.close()
      } catch {}
      await Promise.race([exited, Bun.sleep(5_000)])
      unbridge()
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
    return {
      pty,
      iso,
      zone,
      close,
      live,
      channel,
      person: person.name,
      agent: manifest.name,
      say: (text) => channel.post(person.name, text),
    }
  } catch (e) {
    await closeStation()
    await iso.close().catch(() => {})
    throw e
  }
}

/** Handled while mirab dev runs: being told to stop. The VM is closed either way. */
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

/**
 * The chat in a terminal: one client of its channel. What the person types is
 * said as them; what the agent says is shown. Ctrl-D, or input that ends,
 * ends the chat once everything said is answered; Ctrl-C leaves at once.
 */
export function terminalChat(
  d: Pick<Dev, 'channel' | 'person' | 'agent' | 'say'> & {
    pty: Pick<PtyHandle, 'onExit'>
  },
  input: NodeJS.ReadableStream & { isTTY?: boolean },
  out: NodeJS.WritableStream,
): { done: Promise<number>; leave(code: number): void } {
  let leave: (code: number) => void = () => {}
  const done = new Promise<number>((r) => (leave = r))
  const local = d.agent.split('.').at(-1)
  const tty = Boolean(input.isTTY)
  const chat = createInterface({
    input,
    output: out,
    prompt: 'you> ',
    terminal: tty,
  })
  const waiting = new Set<string>()
  let ending = false
  const settle = () => ending && !waiting.size && leave(0)
  const off = d.channel.onMessage((m) => {
    if (m.from === d.person) return
    if (m.answers) waiting.delete(m.answers)
    if (tty) {
      clearLine(out, 0)
      cursorTo(out, 0)
    }
    // The agent's text is the VM's: shown, never obeyed by the terminal.
    const text = printable(m.text)
    out.write(m.note ? `(${text})\n` : `${local}> ${text}\n`)
    if (!ending && tty) chat.prompt(true)
    settle()
  })
  chat.on('line', (line) => {
    if (line.trim())
      try {
        waiting.add(d.say(line).id)
      } catch (e) {
        out.write(`(${(e as Error).message})\n`)
      }
    if (!ending && tty) chat.prompt()
  })
  chat.on('close', () => {
    ending = true
    settle()
  })
  chat.on('SIGINT', () => leave(130))
  d.pty.onExit(leave)
  if (tty) chat.prompt()
  void done.then(() => {
    off()
    chat.close()
  })
  return { done, leave: (code) => leave(code) }
}

/** `mirab dev` in a terminal. */
export async function devInTerminal(
  options: Omit<Parameters<typeof startDev>[0], 'cols' | 'rows'>,
): Promise<number> {
  let dev: Dev | undefined
  // Being told to stop works while the VM boots too: the boot finishes and
  // the VM is closed, but the chat never opens.
  let stopped: (code: number) => void = () => {}
  const stopping = new Promise<number>((r) => (stopped = r))
  let leave = stopped
  const onSignal = () => leave(143)
  for (const signal of SIGNALS) process.on(signal, onSignal)
  const starting = startDev({ ...options, cols: 80, rows: 24 })
  try {
    const first = await Promise.race([starting, stopping])
    if (typeof first === 'number') {
      // Stopped while it boots: the VM is closed once it is up. Asked again,
      // mirab leaves without waiting, and the VM stops as mirab exits (vz's
      // helper when its input closes, Firecracker on process exit).
      options.log?.(
        'stopping the VM once it is up; Ctrl-C again leaves without waiting',
      )
      const again = new Promise<number>((r) => (leave = r))
      return await Promise.race([
        starting
          .then((d) => d.close())
          .then(
            () => first,
            () => first,
          ),
        again,
      ])
    }
    dev = first
    options.log?.(
      `This chat is ${dev.channel.id}, kept at ${dev.channel.path}. Ctrl-D ends it; Ctrl-C leaves at once.`,
    )
    const chat = terminalChat(dev, process.stdin, process.stdout)
    leave = chat.leave
    return await chat.done
  } finally {
    for (const signal of SIGNALS) process.off(signal, onSignal)
    process.stdin.pause()
    await dev?.close()
  }
}
