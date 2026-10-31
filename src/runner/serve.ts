// serveRunners: keeps each definition's slot filled with a fresh VM that takes
// exactly one job, then throws the VM away. Outbound only: the forge's runner
// in the VM polls the forge; nothing reaches this host.
//
// A slot: image (cached) → VM from a clone of it, filtered internet, nothing
// of the host's inside, no guest-to-host port → ticket (minted only once the
// guest answers, so a failed boot leaves no registration) → files, steps as
// the runner user → the job timer starts at the runner's "job started" line →
// VM closed, disk discarded → next slot.
import { randomBytes } from 'node:crypto'
import {
  appendFile,
  mkdir,
  rename,
  rm,
  statfs,
  writeFile,
} from 'node:fs/promises'
import { availableParallelism, hostname, totalmem } from 'node:os'
import { join } from 'node:path'
import { startVm, vmBackend, type VmConfig } from '../isolation'
import { networkState } from '../isolation/network'
import type { Isolation } from '../isolation/session'
import { vzNetworkState } from '../isolation/vz'
import {
  RUNNER_SETPRIV,
  RUNNER_USER,
  hostRunnerPlatform,
  platformLabel,
  type RunnerDefinition,
  type RunnerPlatform,
  type RunnerStep,
} from './define'
import { HostBudget, type Lease } from './budget'
import {
  runnerImage,
  runnerRecipe,
  type RunnerImage,
  type RunnerRecipe,
} from './image'

export const runnersDir = (configDir: string) => join(configDir, 'runners')

/** idle: no VM, watching the forge for a job (warm 0). queued: waiting for
 *  room in the host's budget. waiting: booted and registered, no job yet. */
export type SlotPhase =
  'image' | 'idle' | 'queued' | 'booting' | 'waiting' | 'busy' | 'stopping'

export interface SlotState {
  vmName: string
  phase: SlotPhase
  since: string
}

export interface RunnerState {
  name: string
  host: string
  forge: string
  image?: string
  slots: SlotState[]
  jobs: number
  lastError?: { at: string; message: string }
}

/** Things serveRunners does to the world; tests pass their own. */
export interface ServeDeps {
  startVm: (
    vm: VmConfig,
    vmDir: string,
    log: (line: string) => void,
  ) => Promise<Isolation>
  image: (def: RunnerDefinition, recipe: RunnerRecipe) => Promise<RunnerImage>
  recipe: (def: RunnerDefinition) => Promise<RunnerRecipe>
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
  now: () => Date
  /** How long a minute is (the job and idle timers); tests shorten it. */
  minuteMs: number
}

export interface ServeOptions {
  configDir: string
  vm: VmConfig
  /** Names registrations `<host>-<name>-<random>`. */
  host?: string
  /** RAM all runner VMs together may use (default: host RAM − 3 GiB). */
  budgetMiB?: number
  /** vCPUs all runner VMs together may use (default: the host's CPUs). */
  budgetVcpus?: number
  signal?: AbortSignal
  log?: (line: string) => void
  deps?: Partial<ServeDeps>
}

const RECIPE_RECHECK_MS = 24 * 3600_000
const BACKOFF_MS = [10_000, 30_000, 60_000, 120_000, 300_000]
const SHUTDOWN_GRACE_MS = 10 * 60_000

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(done, ms)
    function done() {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done)
  })

/** A runner's VM: nothing of the host's inside (no work share or drive) and
 *  no guest-to-host port. */
export function startRunnerVm(
  vm: VmConfig,
  vmDir: string,
  log: (line: string) => void,
): Promise<Isolation> {
  return startVm(vm, null, vmDir, log, undefined, { listen: [] })
}

/** A host name usable in a registration name. */
export function hostLabel(name: string = hostname()): string {
  return (
    name
      .split('.')[0]!
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'host'
  )
}

/** Replaces every secret value in `line` (the ticket's, while it lives). */
export function redact(line: string, secrets: Iterable<string>): string {
  let out = line
  for (const s of secrets)
    if (s.length >= 8) out = out.split(s).join('[redacted]')
  return out
}

/** The env every job step gets: base, then the image's toolsets, then the
 *  forge's job env, then the step's own (later wins). PATH is composed. */
export function jobEnv(
  def: RunnerDefinition,
  image: Pick<RunnerImage['meta'], 'env' | 'path'>,
  job: Record<string, string>,
  step: Record<string, string> = {},
): Record<string, string> {
  const home = RUNNER_USER.home
  const basePath =
    '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
  return {
    HOME: home,
    USER: RUNNER_USER.name,
    LOGNAME: RUNNER_USER.name,
    LANG: 'C.UTF-8',
    // /tmp is a RAM disk in the guest; temp files go on the job's disk.
    TMPDIR: `${home}/tmp`,
    CARGO_BUILD_JOBS: String(def.vm.vcpus),
    ...image.env,
    ...job,
    ...step,
    PATH: [...image.path, step.PATH ?? job.PATH ?? basePath].join(':'),
  }
}

/** Lines longer than this are cut (host side, by guestExec's cutLines). */
export const STEP_LINE_CHARS = 4000

/** The argv mirab really execs for a step: as the runner user unless asRoot.
 *  No pipeline in the guest: anything between the step and the agent can hold
 *  its output back (cut, and mawk without -W interactive, buffer off a
 *  terminal), and a job's "started" line must arrive while it runs, or an
 *  on-demand VM's idle timer ends the job. Long lines are cut on the host. */
export function stepArgv(step: RunnerStep): string[] {
  return step.asRoot ? step.argv : [...RUNNER_SETPRIV, ...step.argv]
}

/** Refuses a host that can't run these definitions safely. */
export async function admission(
  defs: RunnerDefinition[],
  o: {
    configDir: string
    budgetMiB: number
    budgetVcpus: number
    backend: 'vz' | 'firecracker'
    filtered: boolean
    freeBytes: number
  },
): Promise<void> {
  const names = new Set<string>()
  for (const d of defs) {
    if (names.has(d.name)) throw new Error(`two runners are named ${d.name}`)
    names.add(d.name)
  }
  for (const d of defs) {
    if (d.vm.memoryMiB > o.budgetMiB || d.vm.vcpus > o.budgetVcpus)
      throw new Error(
        `${d.name}'s VM (${d.vm.memoryMiB} MiB, ${d.vm.vcpus} vCPUs) is bigger than this host lends runner VMs (${o.budgetMiB} MiB, ${o.budgetVcpus} vCPUs)`,
      )
    if (d.pool.warm === 0 && !d.forge.queued)
      throw new Error(
        `${d.name}: pool.warm 0 needs a forge that reports queued jobs; ${d.forge.name} doesn't`,
      )
  }
  // Warm VMs hold their share for good; what's left is shared on demand.
  const warm = defs.filter((d) => d.pool.warm > 0)
  const mem = warm.reduce((s, d) => s + d.vm.memoryMiB, 0)
  const cpu = warm.reduce((s, d) => s + d.vm.vcpus, 0)
  if (mem > o.budgetMiB || cpu > o.budgetVcpus)
    throw new Error(
      `warm runners hold ${mem} MiB and ${cpu} vCPUs; this host lends ${o.budgetMiB} MiB and ${o.budgetVcpus} vCPUs (make some pools warm: 0, or raise the budget)`,
    )
  const disk =
    defs.reduce((s, d) => s + d.pool.max * d.vm.diskGiB, 0) * 1024 ** 3
  const reserve = 20 * 1024 ** 3
  if (disk + reserve > o.freeBytes)
    throw new Error(
      `runners may fill ${disk / 1024 ** 3} GiB of disk at once; ${Math.floor(o.freeBytes / 1024 ** 3)} GiB is free and 20 GiB stays in reserve`,
    )
  if (!o.filtered)
    throw new Error(
      o.backend === 'vz'
        ? 'runner VMs need the vz network filter (internet yes, LAN and tailnet no): sudo ~/.mirab/bin/mirab vm network setup'
        : 'runner VMs need the filtered mirabbr0 bridge (internet yes, LAN and tailnet no): see docs/VM.md',
    )
}

export async function serveRunners(
  defs: RunnerDefinition[],
  o: ServeOptions,
): Promise<void> {
  const log = o.log ?? ((l: string) => console.log(l))
  const host = hostLabel(o.host)
  const signal = o.signal ?? new AbortController().signal
  const deps: ServeDeps = {
    startVm: startRunnerVm,
    recipe: (def) => runnerRecipe(def),
    image: (_def, recipe) =>
      runnerImage({ configDir: o.configDir, vm: o.vm, recipe, log }),
    sleep,
    now: () => new Date(),
    minuteMs: 60_000,
    ...o.deps,
  }
  const total = {
    memoryMiB: o.budgetMiB ?? Math.floor(totalmem() / 1024 ** 2) - 3072,
    vcpus: o.budgetVcpus ?? availableParallelism(),
  }
  if (!o.deps?.startVm) {
    const backend = vmBackend()
    const fs = await statfs(o.configDir).catch(() => undefined)
    await admission(defs, {
      configDir: o.configDir,
      budgetMiB: total.memoryMiB,
      budgetVcpus: total.vcpus,
      backend,
      filtered:
        backend === 'vz' ? vzNetworkState().filtered : networkState().ready,
      freeBytes: fs ? fs.bavail * fs.bsize : 0,
    })
  }
  const budget = new HostBudget(total)
  await mkdir(runnersDir(o.configDir), { recursive: true, mode: 0o700 })
  const saveHost = atomicWriter(join(runnersDir(o.configDir), 'host.json'))
  const ctx = { host, deps, o, budget, saveHost, hostLog: log, signal }
  await Promise.all(defs.map((def) => serveOne(def, ctx)))
}

/** Writes one file whole, one write at a time (temp file + rename): readers
 *  and a crash never see half a file. */
function atomicWriter(file: string) {
  let saving: Promise<void> = Promise.resolve()
  return (value: unknown) =>
    (saving = saving.then(async () => {
      const tmp = `${file}.${process.pid}.tmp`
      try {
        await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', {
          mode: 0o600,
        })
        await rename(tmp, file)
      } catch {}
    }))
}

interface ServeContext {
  host: string
  deps: ServeDeps
  o: ServeOptions
  budget: HostBudget
  saveHost: (value: unknown) => Promise<void>
  hostLog: (line: string) => void
  signal: AbortSignal
}

/** The labels a registration carries: `mirab-<os>-<arch>`, then the definition's. */
export const runnerLabels = (
  def: RunnerDefinition,
  platform: RunnerPlatform,
) => [...new Set([platformLabel(platform), ...def.labels])]

/** warm 0: waits until the forge reports a job this pool can take. False if
 *  stopped first. A forge that fails is asked again, more slowly. */
async function demand(
  def: RunnerDefinition,
  platform: RunnerPlatform,
  deps: ServeDeps,
  signal: AbortSignal,
  fail: (message: string) => void,
): Promise<boolean> {
  const every = def.pool.pollSeconds * 1000
  let errors = 0
  while (!signal.aborted) {
    try {
      const n = await def.forge.queued!({
        labels: runnerLabels(def, platform),
        platform,
      })
      errors = 0
      if (n > 0) return true
      await deps.sleep(every, signal)
    } catch (e) {
      // One line per outage, not one per poll.
      if (errors++ === 0) fail(`queued: ${(e as Error).message}`)
      await deps.sleep(every * Math.min(2 ** errors, 20), signal)
    }
  }
  return false
}

async function serveOne(def: RunnerDefinition, ctx: ServeContext) {
  const { host, deps, o, budget, hostLog, signal } = ctx
  const dir = join(runnersDir(o.configDir), def.name)
  const vmsDir = join(dir, 'vms')
  const prefix = `${host}-${def.name}-`
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const logFile = join(dir, 'serve.log')
  const secrets = new Set<string>()
  const log = (line: string) => {
    const clean = redact(line, secrets)
    hostLog(`[${def.name}] ${clean}`)
    void appendFile(logFile, `${deps.now().toISOString()} ${clean}\n`).catch(
      () => {},
    )
  }
  const state: RunnerState = {
    name: def.name,
    host,
    forge: def.forge.name,
    slots: [],
    jobs: 0,
  }
  const writeState = atomicWriter(join(dir, 'state.json'))
  const save = () => {
    void ctx.saveHost(budget.snapshot())
    return writeState(state)
  }
  const fail = (message: string) => {
    state.lastError = {
      at: deps.now().toISOString(),
      message: redact(message, secrets),
    }
    log(`error: ${message}`)
  }

  // A crash or reboot left VM directories behind: nothing in them is wanted.
  await rm(vmsDir, { recursive: true, force: true })
  await mkdir(vmsDir, { recursive: true, mode: 0o700 })
  await def.forge
    .reconcile(prefix, [])
    .catch((e) => fail(`reconcile: ${e.message}`))
  await save()

  let recipe: RunnerRecipe | undefined
  let recipeAt = 0
  let failures = 0
  const backoff = async () => {
    const ms = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)]!
    failures++
    log(`retrying in ${ms / 1000} s`)
    await deps.sleep(ms, signal)
  }

  while (!signal.aborted) {
    const vmName = prefix + randomBytes(3).toString('hex')
    const slot: SlotState = {
      vmName,
      phase: 'image',
      since: deps.now().toISOString(),
    }
    const phase = (p: SlotPhase) => {
      slot.phase = p
      slot.since = deps.now().toISOString()
      void save()
    }
    state.slots = [slot]
    let iso: Isolation | undefined
    let lease: Lease | undefined
    let ticketed = false
    try {
      // The recipe names the forge's runner release: look again daily, so a
      // new release becomes a new image between jobs.
      if (!recipe || deps.now().getTime() - recipeAt > RECIPE_RECHECK_MS) {
        recipe = await deps.recipe(def)
        recipeAt = deps.now().getTime()
      }
      phase('image')
      const image = await deps.image(def, recipe)
      state.image = image.meta.key
      if (signal.aborted) break
      if (def.pool.warm === 0) {
        phase('idle')
        if (!(await demand(def, recipe.platform, deps, signal, fail))) break
      }
      phase('queued')
      lease = await budget.acquire(
        { memoryMiB: def.vm.memoryMiB, vcpus: def.vm.vcpus },
        def.name,
        signal,
      )
      phase('booting')
      iso = await deps.startVm(
        {
          ...o.vm,
          rootfs: image.rootfs,
          vcpus: def.vm.vcpus,
          memoryMiB: def.vm.memoryMiB,
          egress: 'allow',
        },
        join(vmsDir, vmName),
        log,
      )
      // Booted and answering: only now is a registration worth making.
      const ticket = await def.forge.ticket({
        name: vmName,
        labels: runnerLabels(def, recipe.platform),
        platform: recipe.platform,
      })
      ticketed = true
      for (const v of Object.values(ticket.secret)) secrets.add(v)
      const job = def.forge.guest.job(ticket)
      for (const f of job.files) {
        if (f.secret) secrets.add(f.content)
        await iso.put(f.path, f.content, f.mode)
      }
      phase('waiting')
      const outcome = await runJob(
        def,
        iso,
        image,
        job,
        signal,
        log,
        deps.minuteMs,
        () => {
          phase('busy')
          state.jobs++
        },
      )
      log(`${vmName}: ${outcome.why}`)
      if (outcome.tookJob || outcome.expected) failures = 0
      else {
        // The runner gave up before any job (a refused or spent registration,
        // a broken image): without this, a new VM would boot every few seconds.
        fail(
          `${vmName}: the runner exited before taking a job (${outcome.why})`,
        )
        if (!signal.aborted) await backoff()
      }
    } catch (e) {
      if (signal.aborted) break
      fail(`${vmName}: ${(e as Error).message}`)
      await backoff()
    } finally {
      phase('stopping')
      await iso?.close().catch((e) => fail(`close ${vmName}: ${e.message}`))
      lease?.release()
      if (ticketed)
        // The runner deregisters itself after its job; anything left (an idle
        // slot ended, a killed job) is removed here.
        await def.forge
          .reconcile(prefix, [])
          .catch((e) => fail(`reconcile: ${e.message}`))
      secrets.clear()
      state.slots = []
      await save()
    }
  }
}

/** Runs the job's steps; returns how the slot ended. */
async function runJob(
  def: RunnerDefinition,
  iso: Isolation,
  image: RunnerImage,
  job: { steps: RunnerStep[]; env: Record<string, string> },
  stop: AbortSignal,
  log: (line: string) => void,
  minuteMs: number,
  onStarted: () => void,
): Promise<{ why: string; tookJob: boolean; expected: boolean }> {
  const ctl = new AbortController()
  let started = false
  let why = 'finished'
  /** Ended on purpose (idle lifetime, shutdown), not by the runner giving up. */
  let expected = false
  // A warm slot waits hours for a job; one booted on demand only minutes,
  // since its job may have gone to another runner.
  const idleMinutes =
    def.pool.warm === 0 ? def.pool.waitMinutes : def.pool.idleHours * 60
  const idleMs = idleMinutes * minuteMs
  const jobMs = def.timeoutMinutes * minuteMs
  const idleTimer = setTimeout(() => {
    if (!started) {
      why =
        def.pool.warm === 0
          ? `no job in ${def.pool.waitMinutes} min (it went elsewhere), ended`
          : `no job in ${def.pool.idleHours} h, ended`
      expected = true
      ctl.abort()
    }
  }, idleMs)
  let jobTimer: ReturnType<typeof setTimeout> | undefined
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  const onStop = () => {
    if (!started) {
      why = 'stopped while waiting'
      expected = true
      ctl.abort()
    } else
      graceTimer = setTimeout(
        () => {
          why = 'stopped: job killed after the shutdown grace period'
          ctl.abort()
        },
        (SHUTDOWN_GRACE_MS / 60_000) * minuteMs,
      )
  }
  stop.addEventListener('abort', onStop)
  if (stop.aborted) onStop()
  try {
    for (const step of job.steps) {
      if (ctl.signal.aborted) break
      const code = await iso.exec(stepArgv(step), {
        cwd: step.asRoot ? '/' : RUNNER_USER.home,
        env: jobEnv(def, image.meta, job.env, step.env),
        cutLines: STEP_LINE_CHARS,
        // A backstop: the timers above end it first.
        timeoutMs: idleMs + jobMs + 10 * 60_000,
        signal: ctl.signal,
        onLine: async (line) => {
          log(line)
          if (!started && def.forge.guest.started(line)) {
            started = true
            clearTimeout(idleTimer)
            onStarted()
            jobTimer = setTimeout(() => {
              why = `job killed at its ${def.timeoutMinutes} min limit`
              ctl.abort()
            }, jobMs)
          }
        },
      })
      if (ctl.signal.aborted) break
      if (code !== 0)
        return {
          why: `step ${step.argv[0]} exited ${code}`,
          tookJob: started,
          expected,
        }
    }
    return { why, tookJob: started, expected }
  } finally {
    clearTimeout(idleTimer)
    clearTimeout(jobTimer)
    clearTimeout(graceTimer)
    stop.removeEventListener('abort', onStop)
  }
}

export { hostRunnerPlatform }
export type { RunnerPlatform }
