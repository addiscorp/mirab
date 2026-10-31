// What a CI runner declares: `defineRunner(...)`. mirab runs each job in a
// fresh VM and throws it away; a forge adapter (woreda's `github()`, later
// gild, GitLab, Forgejo) says how to register for one job and what to run in
// the VM. Nothing here knows any particular forge.
import { z } from 'zod'

/** The guests a runner can run. */
export const RUNNER_PLATFORMS = [
  'linux-x64',
  'linux-arm64',
  'darwin-arm64',
] as const
export type RunnerPlatform = (typeof RUNNER_PLATFORMS)[number]

export const isDarwin = (p: RunnerPlatform) => p.startsWith('darwin-')

/** Every runner carries `mirab-<os>-<arch>` (e.g. `mirab-linux-arm64`), so a
 *  job asks for a fresh VM of a platform with one label. */
export const platformLabel = (platform: RunnerPlatform) => `mirab-${platform}`

/** One command in the VM. Steps run as the unprivileged `runner` user unless
 *  `asRoot` (then the step is responsible for dropping to it, with
 *  `dropToRunner(platform)`). */
export interface RunnerStep {
  argv: string[]
  env?: Record<string, string>
  asRoot?: boolean
}

/** A file put into the VM before the job's steps. `secret` files are never
 *  logged; they should live in `secretDir(platform)` and be removed once read. */
export interface RunnerFile {
  path: string
  mode: number
  content: string
  secret?: boolean
}

/** A one-time credential for exactly one job. Every value in `secret` is
 *  redacted from mirab's logs and never written to the host's disk. */
export interface RunnerTicket {
  name: string
  secret: Record<string, string>
  meta?: Record<string, string>
}

/** What a forge adapter provides. */
export interface Forge {
  name: string
  /** Host side: register one runner called `name` for one job. */
  ticket(req: {
    name: string
    labels: string[]
    platform: RunnerPlatform
  }): Promise<RunnerTicket>
  guest: {
    /** Baked into the runner image as root, in the build VM. `key` names
     *  exactly what is installed (e.g. a version and checksum): a new key is
     *  a new image. Called again at most daily, to notice new releases. */
    install(
      platform: RunnerPlatform,
    ): Promise<{ key: string; steps: RunnerStep[] }>
    /** Hosts the image build may reach for `install`. */
    buildEgress: string[]
    /** One job: files put first, then the steps in order; the last one is
     *  the runner, which takes one job and exits. */
    job(
      ticket: RunnerTicket,
      platform: RunnerPlatform,
    ): {
      files: RunnerFile[]
      steps: RunnerStep[]
      env: Record<string, string>
    }
    /** True for the runner's output line that says a job has started: the
     *  job timer (timeoutMinutes) starts there, not at boot. */
    started(line: string): boolean
  }
  /** Delete this host's registrations named `prefix*` that aren't in `live`. */
  reconcile(prefix: string, live: string[]): Promise<void>
  /** How many jobs are waiting right now that a runner with these labels
   *  could take. Optional; without it a pool can only be warm. Called every
   *  `pool.pollSeconds` while a pool has no VM, so it should be cheap. */
  queued?(req: { labels: string[]; platform: RunnerPlatform }): Promise<number>
}

/** The toolsets a runner image can carry. */
export const TOOLSETS = ['rust', 'node', 'go'] as const

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
const LABEL = /^[A-Za-z0-9._-]{1,64}$/
const PACKAGE = /^[a-z0-9][a-z0-9+.-]*$/

const forgeSchema = z.custom<Forge>(
  (f) =>
    !!f &&
    typeof f === 'object' &&
    typeof (f as Forge).name === 'string' &&
    typeof (f as Forge).ticket === 'function' &&
    typeof (f as Forge).reconcile === 'function' &&
    typeof (f as Forge).guest?.job === 'function' &&
    typeof (f as Forge).guest?.install === 'function' &&
    typeof (f as Forge).guest?.started === 'function' &&
    Array.isArray((f as Forge).guest?.buildEgress),
  'forge is an adapter object (ticket, reconcile, guest.install/job/started/buildEgress)',
)

export const runnerSchema = z.strictObject({
  /** Unique on its host; registrations are `<host>-<name>-<random>`. */
  name: z
    .string()
    .regex(
      NAME,
      'name is [a-z0-9-], up to 40 characters, no leading or trailing -',
    ),
  forge: forgeSchema,
  /** The guest: the host's Linux by default; `darwin-arm64` boots macOS
   *  (Apple silicon hosts, a provisioned macOS base: `vm.macos`). */
  platform: z.enum(RUNNER_PLATFORMS).optional(),
  /** Extra labels, after `platformLabel`'s, passed to the adapter as they are. */
  labels: z.array(z.string().regex(LABEL)).max(32).default([]),
  image: z
    .strictObject({
      /** Pinned versions: rust `1.91.0` or `1.91`; node `24` or `24.21.0`; go `1.25` or `1.25.3`; aws `2` or `2.31.20`. */
      tools: z
        .strictObject({
          rust: z
            .string()
            .regex(/^\d+\.\d+(\.\d+)?$/)
            .optional(),
          node: z
            .string()
            .regex(/^\d+(\.\d+){0,2}$/)
            .optional(),
          go: z
            .string()
            .regex(/^\d+\.\d+(\.\d+)?$/)
            .optional(),
          /** AWS CLI v2: `2` (newest 2.x), `2.31` or `2.31.20` (Linux images). */
          aws: z
            .string()
            .regex(/^2(\.\d+){0,2}$/)
            .optional(),
        })
        .default({}),
      /** apt package names. */
      packages: z
        .array(z.string().regex(PACKAGE, 'an apt package name'))
        .default([]),
    })
    .default({ tools: {}, packages: [] }),
  vm: z
    .strictObject({
      vcpus: z.number().int().min(1).max(64).default(2),
      memoryMiB: z.number().int().min(1024).default(3072),
      /** The job's disk; caps what one job can use of the host's. */
      diskGiB: z.number().int().min(8).max(1024).default(30),
    })
    .default({ vcpus: 2, memoryMiB: 3072, diskGiB: 30 }),
  pool: z
    .strictObject({
      /** 1: a VM always booted and registered, holding its memory. 0: a VM
       *  boots only when the forge reports a job it can take (forge.queued),
       *  so pools share the host's budget instead of each holding a VM. */
      warm: z.number().int().min(0).max(1).default(1),
      /** VMs at once on this host (1 until VM-to-VM isolation is proven). */
      max: z.number().int().min(1).max(1).default(1),
      /** A warm slot nobody gave a job ends after this, and registers again. */
      idleHours: z.number().positive().max(72).default(12),
      /** warm 0: how often to ask the forge for queued jobs. */
      pollSeconds: z.number().int().min(5).max(300).default(15),
      /** warm 0: a VM booted for a job that went elsewhere ends after this. */
      waitMinutes: z.number().int().min(1).max(60).default(3),
    })
    .default({
      warm: 1,
      max: 1,
      idleHours: 12,
      pollSeconds: 15,
      waitMinutes: 3,
    }),
  /** One job's hard limit, from the moment it starts; the VM is killed after. */
  timeoutMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60)
    .default(90),
})

export type RunnerDefinition = z.infer<typeof runnerSchema>
export type RunnerInput = z.input<typeof runnerSchema>

export function defineRunner(input: RunnerInput): RunnerDefinition {
  const parsed = runnerSchema.safeParse(input)
  if (!parsed.success)
    throw new Error(
      `defineRunner: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'runner'}: ${i.message}`).join('; ')}`,
    )
  return Object.freeze(parsed.data)
}

/** The unprivileged user every job step runs as (created in the runner image). */
export const RUNNER_USER = { name: 'runner', uid: 1001, home: '/home/runner' }

/** The runner user on a platform: macOS keeps homes under /Users. */
export const runnerUser = (p: RunnerPlatform) =>
  isDarwin(p) ? { ...RUNNER_USER, home: '/Users/runner' } : RUNNER_USER

/** Prefix that drops a root command to the runner user, keeping its env (Linux). */
export const RUNNER_SETPRIV = [
  'setpriv',
  `--reuid=${RUNNER_USER.uid}`,
  `--regid=${RUNNER_USER.uid}`,
  '--init-groups',
]

/** Prefix that drops a root command to the runner user, keeping its env.
 *  macOS has no setpriv; root's sudo keeps the env with -E. */
export const dropToRunner = (p: RunnerPlatform): string[] =>
  isDarwin(p)
    ? ['/usr/bin/sudo', '-E', '-H', '-u', RUNNER_USER.name, '--']
    : RUNNER_SETPRIV

/** Where one-job secrets go: tmpfs on Linux; macOS has no /run, and its
 *  per-job disk is thrown away with the VM. */
export const secretDir = (p: RunnerPlatform) =>
  isDarwin(p) ? '/private/var/run/mirab' : '/run/mirab'

/** The Linux guest platform a VM on this host runs (a definition may ask for
 *  a macOS guest instead with `platform: 'darwin-arm64'`). */
export function hostRunnerPlatform(
  arch: string = process.arch,
): RunnerPlatform {
  if (arch === 'arm64') return 'linux-arm64'
  if (arch === 'x64') return 'linux-x64'
  throw new Error(`no runner guest for ${arch} hosts`)
}
