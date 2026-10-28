// `mirab spawn --vm`: the agent process runs on a pty inside a microVM
// (Firecracker on Linux, Virtualization.framework on macOS); the host keeps the terminal, session socket, hooks, injection queue
// and everything else (spawn-worker.ts). This file only builds the guest
// child and the hook relay.
import { projectAgent } from 'rixse'
import { createConnection } from 'node:net'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { requireVm, startVm, type Isolation, type VmConfig } from './isolation'
import { privateSessionsDirectory, socketPath } from './spawn-sessions'
import type { StationConfig } from './station/config'
import type { Upstream } from 'rixse'
import { GUEST_PROXY, vmStation, type VmStation } from './station/gateway'
import { claudeRoute, withClaudeRoute } from 'rixse'
import { hararVault } from './station/vault'
import {
  describeSync,
  hostManifest,
  syncBack,
  type SyncResult,
  type RecoveryLocation,
} from './isolation/sync'

export const GUEST_AGENT = '/usr/local/bin/mirab-guest-agent'
const GUEST_PATH =
  '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
const MAX_UPLOAD = 1 << 20

export interface VmChild {
  pid: number
  write(data: string | Uint8Array): void
  resize(cols: number, rows: number): void
  onData(cb: (data: Buffer) => void): void
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void
  pause(): void
  resume(): void
  /** Hang up the guest session (the agent gets SIGHUP). */
  kill(): void
  /** Copy the guest's changes to the working directory back to the host now. */
  sync(): Promise<SyncResult>
  /** Sync once, then stop; incomplete sync retains the workspace for recovery. */
  dispose(): Promise<SyncResult | undefined>
  /** Available even when final sync throws; contains only private local paths. */
  readonly recovery?: RecoveryLocation
}

export class VmSyncError extends Error {
  constructor(
    message: string,
    readonly recovery: RecoveryLocation,
    cause: unknown,
  ) {
    super(message, { cause })
  }
}

/** Shut down the VM without deleting work that could not safely reach the host. */
export async function finishVmSync(
  sync: () => Promise<SyncResult>,
  isolation: Pick<Isolation, 'close'>,
  vmDir: string,
  log: (line: string) => void = (line) => console.error(`mirab: ${line}`),
) {
  let result: SyncResult | undefined, failure: unknown
  try {
    result = await sync()
  } catch (e) {
    failure = e
  }
  const preserve =
    failure !== undefined ||
    !result ||
    result.conflicts.length > 0 ||
    result.rejected.length > 0
  const recovery: RecoveryLocation = {
    directory: vmDir,
    note: join(vmDir, 'recovery.json'),
  }
  try {
    await isolation.close({ preserveWorkspace: preserve })
  } catch (e) {
    log(`VM shutdown failed; recovery workspace: ${vmDir}`)
    throw new VmSyncError(
      `VM shutdown failed: ${(e as Error).message}`,
      recovery,
      e,
    )
  }
  if (preserve) {
    log(`VM workspace retained for recovery: ${vmDir}`)
    // No tokens or process environment are persisted in this host-owned note.
    try {
      await writeFile(
        join(vmDir, 'recovery.json'),
        JSON.stringify(
          {
            state: 'sync-incomplete',
            createdAt: new Date().toISOString(),
            error:
              failure instanceof Error
                ? failure.message
                : failure
                  ? String(failure)
                  : undefined,
            result,
          },
          null,
          2,
        ) + '\n',
        { mode: 0o600 },
      )
    } catch (e) {
      throw new VmSyncError(
        `Writing recovery note failed: ${(e as Error).message}`,
        recovery,
        e,
      )
    }
    if (result) result = { ...result, recovery }
  }
  if (failure !== undefined)
    throw new VmSyncError(
      failure instanceof Error ? failure.message : String(failure),
      recovery,
      failure,
    )
  return result!
}

/**
 * Git in the guest trusts the work directory. Its files keep the host user's
 * uid (mke2fs -d copies ownership) while the agent runs as root, so without
 * this every git command in /workspace stops at "detected dubious ownership".
 * Set through git's environment config, so it needs no change to the image.
 */
export const guestGitEnvironment = (work = '/workspace') => ({
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'safe.directory',
  GIT_CONFIG_VALUE_0: work,
})

/** Env for the guest: a fixed baseline plus only what the adapter or profile added; never the host env. */
export function guestEnvironment(
  hostEnv: Record<string, string | undefined>,
  baseline: Record<string, string | undefined>,
  allowlist?: string[],
) {
  const out: Record<string, string> = {
    PATH: GUEST_PATH,
    HOME: '/root',
    TERM: 'xterm-256color',
    LANG: 'C.UTF-8',
    ...guestGitEnvironment(),
  }
  for (const [k, v] of Object.entries(hostEnv)) {
    if (v === undefined || k in out) continue
    const addedByAdapter = baseline[k] !== v
    if (addedByAdapter || allowlist?.includes(k)) out[k] = v
  }
  return out
}

/** Moved to isolation (the runner side needs it without the agent session code). */
export { requireVm }

export async function startVmChild(opts: {
  configDir: string
  sessionId: string
  cwd: string
  binary: string
  args: string[]
  env: Record<string, string>
  cols: number
  rows: number
  log?: (line: string) => void
  /** The station, for Claude Code on the person's own subscription. */
  station?: {
    config: StationConfig
    /** Where its decisions go (JSON lines). */
    auditLog: string
    /** Where the claude route goes; tests point it at a stand-in. */
    upstream?: string
    /** Where the hosts the station opens are; tests point them at a stand-in. */
    opened?: (host: string) => Promise<Upstream>
  }
}): Promise<VmChild> {
  const vm = await requireVm(opts.configDir, opts.log)
  const kb = Number(
    execFileSync('du', ['-sk', opts.cwd], { encoding: 'utf8' }).split(/\s+/)[0],
  )
  if (kb > 2 * 1024 * 1024)
    throw new Error(
      `${opts.cwd} is larger than 2 GiB; --vm copies the working directory into the VM`,
    )
  // What the guest starts from: the baseline every later sync is compared to.
  const baseline = await hostManifest(opts.cwd)
  const vmDir = await mkdtemp(
    join(await privateSessionsDirectory(), `${opts.sessionId}.vm-`),
  )
  const iso: Isolation = await startVm(vm, opts.cwd, vmDir, opts.log)
  const fail = async (e: unknown) => {
    await iso.close()
    throw e
  }
  try {
    // Hooks run inside the guest and arrive here over vsock; only this session's id is accepted.
    iso.onGuestMessage!(9100, (m) => {
      if (
        m?.op !== 'hook' ||
        m.session !== opts.sessionId ||
        typeof m.raw !== 'string'
      )
        return
      let raw: unknown
      try {
        raw = JSON.parse(m.raw)
      } catch {
        return
      }
      const s = createConnection(socketPath(opts.sessionId))
      s.on('error', () => {})
      s.on('connect', () =>
        s.end(
          JSON.stringify({
            type: 'hook',
            agent: String(m.agent ?? 'claude'),
            raw,
          }) + '\n',
        ),
      )
    })
    // Small files the host prepared (hook settings, a script agent) are copied into the guest tmpfs.
    let n = 0
    const upload = async (path: string, executable: boolean) => {
      if (!isAbsolute(path)) return undefined
      const st = await stat(path).catch(() => null)
      if (!st?.isFile() || st.size > MAX_UPLOAD) return undefined
      const target = `/tmp/mirab/${n++}-${basename(path)}`
      await iso.put(
        target,
        await readFile(path, 'utf8'),
        executable ? 0o700 : 0o600,
      )
      return target
    }
    const head = await readFile(opts.binary, {
      encoding: 'latin1',
      flag: 'r',
    }).then(
      (t) => t.slice(0, 2),
      () => '',
    )
    const program =
      (head === '#!' && (await upload(opts.binary, true))) ||
      basename(opts.binary)
    const args: string[] = []
    for (const a of opts.args) args.push((await upload(a, false)) ?? a)
    // The station is the VM's way out: Claude Code on the person's own
    // subscription (the VM holds a placeholder, the station adds the token from
    // harar), and the keys the project's .env names, as placeholders the
    // station swaps on their own hosts. Any program named claude gets the
    // route; whatever it is, it can reach only api.anthropic.com/v1/messages.
    let env = opts.env
    let station: VmStation | undefined
    const isClaude = basename(opts.binary) === 'claude'
    if (opts.station) {
      const claude = isClaude
        ? claudeRoute(
            hararVault(opts.station.config.harar.socket),
            opts.station.config.models.claude?.token,
            opts.station.upstream,
          )
        : undefined
      station = await vmStation({
        project: opts.cwd,
        station: opts.station.config,
        configDir: opts.configDir,
        // No harar identity for spawn sessions yet (#2): named by session.
        zone: `vm-${opts.sessionId}`,
        auditLog: opts.station.auditLog,
        routes: claude ? { claude } : {},
        allow: [],
        agent: projectAgent(opts.cwd),
        upstream: opts.station.opened,
      })
      for (const note of station.notes) opts.log?.(note)
      await station.attach(iso)
      env = { ...env, ...station.env }
      if (claude) env = withClaudeRoute(env, GUEST_PROXY)
    }
    if (isClaude && !opts.station?.config.models.claude)
      opts.log?.(
        'Claude Code in the VM has no login: add models.claude.token to station.json (the harar secret from `claude setup-token`)',
      )
    const pty = await iso.pty!({
      argv: [program, ...args],
      env,
      cwd: '/workspace',
      cols: opts.cols,
      rows: opts.rows,
    })
    const conflictDir = join(
      await privateSessionsDirectory(),
      `${opts.sessionId}.conflicts`,
    )
    // One sync at a time; each one carries only what changed since the last.
    let chain: Promise<unknown> = Promise.resolve()
    const sync = () => {
      const next = chain.then(async () => {
        const r = await syncBack({
          root: opts.cwd,
          guestRoot: '/workspace',
          files: iso.files!,
          baseline,
          conflictDir,
        })
        opts.log?.(`synced ${describeSync(r)}`)
        return r
      })
      chain = next.catch(() => {})
      return next
    }
    let disposed: Promise<SyncResult | undefined> | undefined
    let recovery: RecoveryLocation | undefined
    const dispose = async () => {
      await station?.close()
      try {
        const result = await finishVmSync(sync, iso, vmDir, opts.log)
        recovery = result.recovery
        return result
      } catch (e) {
        if (e instanceof VmSyncError) recovery = e.recovery
        throw e
      }
    }
    return {
      pid: -1,
      write: (d) => pty.write(d),
      resize: (c, r) => pty.resize(c, r),
      onData: (cb) => pty.onData(cb),
      // guestPty replays an exit that happened before this listener.
      onExit: (cb) => pty.onExit((code) => cb({ exitCode: code })),
      pause() {},
      resume() {},
      kill: () => pty.close(),
      sync,
      dispose: () => (disposed ??= dispose()),
      get recovery() {
        return recovery
      },
    }
  } catch (e) {
    return fail(e)
  }
}
